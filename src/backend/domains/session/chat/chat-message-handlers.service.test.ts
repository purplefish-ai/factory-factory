import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/shared/acp-protocol';

const { mockSessionDomainService, mockSessionService, mockSessionDataService } = vi.hoisted(() => ({
  mockSessionDomainService: {
    peekNextMessage: vi.fn(),
    dequeueNext: vi.fn(),
    requeueFront: vi.fn(),
    markError: vi.fn(),
    markIdle: vi.fn(),
    markRunning: vi.fn(),
    allocateOrder: vi.fn(),
    emitDelta: vi.fn(),
    commitSentUserMessageAtOrder: vi.fn(),
    getQueueLength: vi.fn(),
  },
  mockSessionService: {
    getClient: vi.fn(),
    getSessionClient: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
    setSessionThinkingBudget: vi.fn(),
    sendSessionMessage: vi.fn(),
  },
  mockSessionDataService: {
    findAgentSessionById: vi.fn(),
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: mockSessionDomainService,
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: mockSessionService,
}));

vi.mock('@/backend/domains/session/data/session-data.service', () => ({
  sessionDataService: mockSessionDataService,
}));

vi.mock('./chat-message-handlers/registry', () => ({
  createChatMessageHandlerRegistry: () => ({}),
}));

import { chatMessageHandlerService } from './chat-message-handlers.service';

describe('chatMessageHandlerService.tryDispatchNextMessage', () => {
  const queuedMessage: QueuedMessage = {
    id: 'm1',
    text: 'hello',
    timestamp: '2026-02-01T00:00:00.000Z',
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Configure the init policy bridge (replaces direct import of getWorkspaceInitPolicy)
    chatMessageHandlerService.configure({
      initPolicy: {
        getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }),
      },
    });
    mockSessionDomainService.peekNextMessage.mockReturnValue(queuedMessage);
    mockSessionDomainService.dequeueNext.mockReturnValue(queuedMessage);
    mockSessionDomainService.allocateOrder.mockReturnValue(0);
    mockSessionService.setSessionThinkingBudget.mockResolvedValue(undefined);
    mockSessionService.setSessionModel.mockResolvedValue(undefined);
    mockSessionService.setSessionReasoningEffort.mockResolvedValue(undefined);
    mockSessionService.sendSessionMessage.mockResolvedValue(undefined);
    mockSessionService.isSessionWorking.mockReturnValue(false);
    mockSessionService.isSessionRunning.mockReturnValue(true);
    mockSessionDataService.findAgentSessionById.mockResolvedValue({
      workspace: {
        status: 'READY',
        worktreePath: '/tmp/w1',
        initErrorMessage: null,
      },
    });
  });

  it('reverts runtime to idle when dispatch fails after markRunning', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionService.sendSessionMessage.mockRejectedValue(new Error('send failed'));

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
    expect(mockSessionService.setSessionThinkingBudget).toHaveBeenCalledWith('s1', null);
    expect(mockSessionService.setSessionModel).toHaveBeenCalledWith('s1', undefined);
    expect(mockSessionService.setSessionReasoningEffort).toHaveBeenCalledWith('s1', null);
    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    expect(mockSessionDomainService.markIdle).toHaveBeenCalledWith('s1', 'alive');
    expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
  });

  it('does not call markIdle when process has already stopped during dispatch failure', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionService.sendSessionMessage.mockRejectedValue(new Error('send failed'));
    mockSessionService.isSessionRunning.mockReturnValueOnce(true).mockReturnValue(false);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
    expect(mockSessionDomainService.markIdle).not.toHaveBeenCalled();
    expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
  });

  it('marks runtime as error when auto-start cannot run because client creator is missing', async () => {
    mockSessionService.getSessionClient.mockReturnValue(undefined);
    mockSessionService.isSessionRunning.mockReturnValue(false);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.markError).toHaveBeenCalledWith('s1');
    // Message was never dequeued — stays in queue
    expect(mockSessionDomainService.dequeueNext).not.toHaveBeenCalled();
  });

  it('skips thinking budget updates for non-Claude clients', async () => {
    const codexMessage: QueuedMessage = {
      ...queuedMessage,
      settings: {
        ...queuedMessage.settings,
        thinkingEnabled: true,
      },
    };
    mockSessionDomainService.peekNextMessage.mockReturnValue(codexMessage);
    mockSessionDomainService.dequeueNext.mockReturnValue(codexMessage);
    mockSessionService.getSessionClient.mockReturnValue({ sessionId: 's1', threadId: 't1' });

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionService.setSessionThinkingBudget).not.toHaveBeenCalled();
    expect(mockSessionService.setSessionModel).toHaveBeenCalledWith('s1', undefined);
    expect(mockSessionService.setSessionReasoningEffort).toHaveBeenCalledWith('s1', null);
    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
    expect(mockSessionDomainService.emitDelta).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'message_state_changed',
        id: 'm1',
        newState: 'COMMITTED',
        userMessage: expect.objectContaining({
          text: 'hello',
          order: 0,
        }),
      })
    );
  });

  it('leaves message in queue when dispatch gate evaluation throws', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionDataService.findAgentSessionById.mockRejectedValue(new Error('db down'));

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    // Message was never dequeued, so no requeueFront needed
    expect(mockSessionDomainService.dequeueNext).not.toHaveBeenCalled();
    expect(mockSessionDomainService.requeueFront).not.toHaveBeenCalled();
    expect(mockSessionDomainService.markRunning).not.toHaveBeenCalled();
  });

  it('rejects queued messages for archived workspaces instead of leaving them stuck', async () => {
    chatMessageHandlerService.configure({
      initPolicy: {
        getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'blocked' }),
      },
    });
    mockSessionDataService.findAgentSessionById.mockResolvedValue({
      workspace: {
        status: 'ARCHIVED',
        worktreePath: '/tmp/w1',
        initErrorMessage: null,
      },
    });

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.dequeueNext).toHaveBeenCalledWith('s1', {
      emitSnapshot: false,
    });
    expect(mockSessionDomainService.emitDelta).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'message_state_changed',
        id: 'm1',
        newState: 'REJECTED',
        errorMessage: expect.stringContaining('Workspace is archived'),
      })
    );
    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('keeps queued messages during temporary blocked states (e.g. provisioning)', async () => {
    chatMessageHandlerService.configure({
      initPolicy: {
        getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'blocked' }),
      },
    });
    mockSessionDataService.findAgentSessionById.mockResolvedValue({
      workspace: {
        status: 'PROVISIONING',
        worktreePath: null,
        initErrorMessage: null,
      },
    });

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.dequeueNext).not.toHaveBeenCalled();
    expect(mockSessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'message_state_changed',
        newState: 'REJECTED',
      })
    );
    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
  });
});
