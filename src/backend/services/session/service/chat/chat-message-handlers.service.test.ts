import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/shared/acp-protocol';

const {
  mockSessionDomainService,
  mockSessionService,
  mockSessionDataService,
  mockWorkspaceNotificationAccessor,
} = vi.hoisted(() => ({
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
    removeTranscriptMessageById: vi.fn(),
    removeQueuedMessage: vi.fn(),
    getQueueLength: vi.fn(),
    getTranscriptSnapshot: vi.fn(),
  },
  mockSessionService: {
    getClient: vi.fn(),
    getSessionClient: vi.fn(),
    isSessionStopping: vi.fn(),
    getStopGeneration: vi.fn(),
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
  mockWorkspaceNotificationAccessor: {
    markDelivered: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: mockSessionDomainService,
}));

vi.mock('@/backend/services/session/service/lifecycle/session.service', () => ({
  sessionService: mockSessionService,
}));

vi.mock('@/backend/services/session/service/data/session-data.service', () => ({
  sessionDataService: mockSessionDataService,
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceNotificationAccessor: mockWorkspaceNotificationAccessor,
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
    chatMessageHandlerService.resetDispatchState('s1');
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
    mockWorkspaceNotificationAccessor.markDelivered.mockResolvedValue(undefined);
    mockWorkspaceNotificationAccessor.findById.mockResolvedValue(null);
    mockSessionDomainService.getTranscriptSnapshot.mockReturnValue([]);
    mockSessionDomainService.removeQueuedMessage.mockReturnValue(true);
    mockSessionService.isSessionWorking.mockReturnValue(false);
    mockSessionService.isSessionRunning.mockReturnValue(true);
    mockSessionService.isSessionStopping.mockReturnValue(false);
    mockSessionService.getStopGeneration.mockReturnValue(0);
    mockSessionDataService.findAgentSessionById.mockResolvedValue({
      workspace: {
        status: 'READY',
        worktreePath: '/tmp/w1',
        initErrorMessage: null,
      },
    });
  });

  it('leaves queued messages untouched while the session is stopping', async () => {
    mockSessionService.isSessionStopping.mockReturnValue(true);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.peekNextMessage).not.toHaveBeenCalled();
    expect(mockSessionDomainService.dequeueNext).not.toHaveBeenCalled();
    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('leaves the message queued when stop begins during dispatch gate evaluation', async () => {
    mockSessionService.getSessionClient.mockReturnValue({});
    let resolveSession!: (session: {
      workspace: {
        status: string;
        worktreePath: string;
        initErrorMessage: null;
      };
    }) => void;
    mockSessionDataService.findAgentSessionById.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      })
    );

    const dispatchPromise = chatMessageHandlerService.tryDispatchNextMessage('s1');
    await vi.waitFor(() => {
      expect(mockSessionDataService.findAgentSessionById).toHaveBeenCalledWith('s1');
    });

    mockSessionService.isSessionStopping.mockReturnValue(true);
    resolveSession({
      workspace: {
        status: 'READY',
        worktreePath: '/tmp/w1',
        initErrorMessage: null,
      },
    });
    await dispatchPromise;

    expect(mockSessionDomainService.dequeueNext).not.toHaveBeenCalled();
    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('does not reject a queued message when stop begins during permanent gate evaluation', async () => {
    chatMessageHandlerService.configure({
      initPolicy: {
        getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'blocked' }),
      },
    });
    let resolveSession!: (session: {
      workspace: {
        status: string;
        worktreePath: string;
        initErrorMessage: null;
      };
    }) => void;
    mockSessionDataService.findAgentSessionById.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      })
    );

    const dispatchPromise = chatMessageHandlerService.tryDispatchNextMessage('s1');
    await vi.waitFor(() => {
      expect(mockSessionDataService.findAgentSessionById).toHaveBeenCalledWith('s1');
    });

    mockSessionService.isSessionStopping.mockReturnValue(true);
    resolveSession({
      workspace: {
        status: 'ARCHIVED',
        worktreePath: '/tmp/w1',
        initErrorMessage: null,
      },
    });
    await dispatchPromise;

    expect(mockSessionDomainService.dequeueNext).not.toHaveBeenCalled();
    expect(mockSessionDomainService.emitDelta).not.toHaveBeenCalled();
  });

  it('does not send or commit a dequeued message when stop begins during dispatch configuration', async () => {
    let resolveModelUpdate!: () => void;
    const modelUpdate = new Promise<void>((resolve) => {
      resolveModelUpdate = resolve;
    });
    mockSessionService.getSessionClient.mockReturnValue({});
    mockSessionService.setSessionModel.mockReturnValue(modelUpdate);

    const dispatchPromise = chatMessageHandlerService.tryDispatchNextMessage('s1');
    await vi.waitFor(() => {
      expect(mockSessionService.setSessionModel).toHaveBeenCalledWith('s1', undefined);
    });

    mockSessionService.isSessionStopping.mockReturnValue(true);
    resolveModelUpdate();
    await dispatchPromise;

    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
    expect(mockSessionDomainService.markRunning).not.toHaveBeenCalled();
    expect(mockSessionDomainService.commitSentUserMessageAtOrder).not.toHaveBeenCalled();
    expect(mockSessionDomainService.requeueFront).not.toHaveBeenCalled();
  });

  it('does not send or requeue a dequeued message when stop completes during configuration', async () => {
    let resolveModelUpdate!: () => void;
    const modelUpdate = new Promise<void>((resolve) => {
      resolveModelUpdate = resolve;
    });
    let stopGeneration = 0;
    mockSessionService.getStopGeneration.mockImplementation(() => stopGeneration);
    mockSessionService.getSessionClient.mockReturnValue({});
    mockSessionService.setSessionModel.mockReturnValue(modelUpdate);

    const dispatchPromise = chatMessageHandlerService.tryDispatchNextMessage('s1');
    await vi.waitFor(() => {
      expect(mockSessionService.setSessionModel).toHaveBeenCalledWith('s1', undefined);
    });

    stopGeneration += 1;
    resolveModelUpdate();
    await dispatchPromise;

    expect(mockSessionService.isSessionStopping).toHaveReturnedWith(false);
    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
    expect(mockSessionDomainService.markRunning).not.toHaveBeenCalled();
    expect(mockSessionDomainService.commitSentUserMessageAtOrder).not.toHaveBeenCalled();
    expect(mockSessionDomainService.requeueFront).not.toHaveBeenCalled();
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
    expect(mockSessionDomainService.removeTranscriptMessageById).toHaveBeenCalledWith('s1', 'm1', {
      emitSnapshot: false,
    });
    expect(mockSessionDomainService.markIdle).toHaveBeenCalledWith('s1', 'alive');
    expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
    const removeCallOrder =
      mockSessionDomainService.removeTranscriptMessageById.mock.invocationCallOrder[0];
    const requeueCallOrder = mockSessionDomainService.requeueFront.mock.invocationCallOrder[0];
    expect(removeCallOrder).toBeDefined();
    expect(requeueCallOrder).toBeDefined();
    expect(removeCallOrder!).toBeLessThan(requeueCallOrder!);
  });

  it('marks a workspace notification delivered after its queued message commits', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    const notificationMessage = {
      ...queuedMessage,
      id: 'workspace-notification-notif-parent',
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionDomainService.peekNextMessage.mockReturnValue(notificationMessage);
    mockSessionDomainService.dequeueNext.mockReturnValue(notificationMessage);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    expect(mockWorkspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('drops a duplicate notification and dispatches the next queued message', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    const notificationMessage = {
      ...queuedMessage,
      id: 'workspace-notification-notif-parent',
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    // Duplicate at the head of the queue, a regular message behind it.
    mockSessionDomainService.peekNextMessage
      .mockReturnValueOnce(notificationMessage)
      .mockReturnValue(queuedMessage);
    mockSessionDomainService.getTranscriptSnapshot.mockReturnValue([
      { source: 'user', id: 'workspace-notification-notif-parent', text: 'hello' },
    ]);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    // The duplicate is removed with a queue-state update, not silently dequeued.
    expect(mockSessionDomainService.removeQueuedMessage).toHaveBeenCalledWith(
      's1',
      'workspace-notification-notif-parent'
    );
    // The message behind the duplicate still dispatches in the same pass.
    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    expect(mockWorkspaceNotificationAccessor.markDelivered).not.toHaveBeenCalled();
  });

  it('drops a workspace notification whose row is already marked delivered', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    const notificationMessage = {
      ...queuedMessage,
      id: 'workspace-notification-notif-parent',
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionDomainService.peekNextMessage
      .mockReturnValueOnce(notificationMessage)
      .mockReturnValue(undefined);
    mockWorkspaceNotificationAccessor.findById.mockResolvedValue({
      id: 'notif-parent',
      deliveredAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockWorkspaceNotificationAccessor.findById).toHaveBeenCalledWith('notif-parent');
    expect(mockSessionDomainService.removeQueuedMessage).toHaveBeenCalledWith(
      's1',
      'workspace-notification-notif-parent'
    );
    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
    expect(mockSessionDomainService.markRunning).not.toHaveBeenCalled();
  });

  it('drops a duplicate while another session is delivering the same notification', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    const notificationMessage = {
      ...queuedMessage,
      id: 'workspace-notification-notif-parent',
    };
    chatMessageHandlerService.resetDispatchState('s2');
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockWorkspaceNotificationAccessor.findById.mockResolvedValue({
      id: 'notif-parent',
      deliveredAt: null,
    });
    let resolveSend!: () => void;
    mockSessionService.sendSessionMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = () => resolve();
        })
    );
    const s2Queue: QueuedMessage[] = [notificationMessage];
    mockSessionDomainService.peekNextMessage.mockImplementation((sessionId: string) =>
      sessionId === 's2' ? s2Queue[0] : notificationMessage
    );
    mockSessionDomainService.dequeueNext.mockReturnValue(notificationMessage);
    mockSessionDomainService.removeQueuedMessage.mockImplementation((sessionId: string) => {
      if (sessionId === 's2') {
        s2Queue.shift();
      }
      return true;
    });

    // Session 1 starts delivering the notification and blocks in send.
    const firstDispatch = chatMessageHandlerService.tryDispatchNextMessage('s1');
    await vi.waitFor(() => {
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(1);
    });

    // Session 2 holds a copy of the same notification; it must not send it again.
    await chatMessageHandlerService.tryDispatchNextMessage('s2');

    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(1);
    expect(mockSessionDomainService.removeQueuedMessage).toHaveBeenCalledWith(
      's2',
      'workspace-notification-notif-parent'
    );

    resolveSend();
    await firstDispatch;
    expect(mockWorkspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent']);
  });

  it('dispatches a workspace notification whose row is still pending', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    const notificationMessage = {
      ...queuedMessage,
      id: 'workspace-notification-notif-parent',
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionDomainService.peekNextMessage.mockReturnValue(notificationMessage);
    mockSessionDomainService.dequeueNext.mockReturnValue(notificationMessage);
    mockWorkspaceNotificationAccessor.findById.mockResolvedValue({
      id: 'notif-parent',
      deliveredAt: null,
    });

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    expect(mockWorkspaceNotificationAccessor.markDelivered).toHaveBeenCalledWith(['notif-parent']);
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
    expect(mockSessionDomainService.removeTranscriptMessageById).toHaveBeenCalledWith('s1', 'm1', {
      emitSnapshot: false,
    });
    expect(mockSessionDomainService.markIdle).not.toHaveBeenCalled();
    expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
  });

  it.each([
    {
      name: 'missing attachment data',
      attachments: [
        {
          id: 'text-1',
          name: 'notes.txt',
          type: 'text/plain',
          size: 10,
          data: '',
          contentType: 'text' as const,
        },
      ],
      errorMessage: 'Attachment "notes.txt" is missing data',
    },
    {
      name: 'invalid image base64 data',
      attachments: [
        {
          id: 'image-1',
          name: 'screenshot.png',
          type: 'image/png',
          size: 10,
          data: 'invalid base64 with spaces!',
          contentType: 'image' as const,
        },
      ],
      errorMessage: 'Attachment "screenshot.png" has invalid image data',
    },
  ])('rejects queued messages with $name instead of requeueing', async ({
    attachments,
    errorMessage,
  }) => {
    const malformedAttachmentMessage: QueuedMessage = {
      ...queuedMessage,
      attachments,
    };
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionDomainService.peekNextMessage.mockReturnValue(malformedAttachmentMessage);
    mockSessionDomainService.dequeueNext.mockReturnValue(malformedAttachmentMessage);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionService.sendSessionMessage).not.toHaveBeenCalled();
    expect(mockSessionDomainService.removeTranscriptMessageById).toHaveBeenCalledWith('s1', 'm1', {
      emitSnapshot: false,
    });
    expect(mockSessionDomainService.markIdle).toHaveBeenCalledWith('s1', 'alive');
    expect(mockSessionDomainService.requeueFront).not.toHaveBeenCalled();
    expect(mockSessionDomainService.emitDelta).toHaveBeenCalledWith('s1', {
      type: 'message_state_changed',
      id: 'm1',
      newState: 'REJECTED',
      errorMessage,
    });
  });

  it('backs off instead of immediately retrying when ACP reports an active turn', async () => {
    vi.useFakeTimers();
    try {
      const client = {
        isCompactingActive: vi.fn().mockReturnValue(false),
        startCompaction: vi.fn(),
        endCompaction: vi.fn(),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockSessionService.getSessionClient.mockReturnValue(client);
      mockSessionService.sendSessionMessage
        .mockRejectedValueOnce({
          code: -32_600,
          message: 'Invalid request',
          data: { reason: 'A turn is already in progress for this session' },
        })
        .mockResolvedValueOnce(undefined);

      await chatMessageHandlerService.tryDispatchNextMessage('s1');

      expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
      expect(mockSessionDomainService.markIdle).not.toHaveBeenCalled();
      expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(1);

      await chatMessageHandlerService.tryDispatchNextMessage('s1');
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(2);
      });
    } finally {
      chatMessageHandlerService.resetDispatchState('s1');
      vi.useRealTimers();
    }
  });

  it('lets prompt-turn completion bypass a pending active-turn backoff', async () => {
    vi.useFakeTimers();
    try {
      const client = {
        isCompactingActive: vi.fn().mockReturnValue(false),
        startCompaction: vi.fn(),
        endCompaction: vi.fn(),
        setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      };
      mockSessionService.getSessionClient.mockReturnValue(client);
      mockSessionService.sendSessionMessage
        .mockRejectedValueOnce({
          code: -32_600,
          message: 'Invalid request',
          data: { reason: 'A turn is already in progress for this session' },
        })
        .mockResolvedValueOnce(undefined);

      await chatMessageHandlerService.tryDispatchNextMessage('s1');
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(1);

      await chatMessageHandlerService.tryDispatchNextMessage('s1', {
        bypassTurnInProgressBackoff: true,
      });
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledTimes(2);
    } finally {
      chatMessageHandlerService.resetDispatchState('s1');
      vi.useRealTimers();
    }
  });

  it('marks runtime as error when auto-start cannot run because client creator is missing', async () => {
    mockSessionService.getSessionClient.mockReturnValue(undefined);
    mockSessionService.isSessionRunning.mockReturnValue(false);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.markError).toHaveBeenCalledWith(
      's1',
      'Failed to start agent: client creator not configured'
    );
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

  it('persists dispatched user message before turn completion', async () => {
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionService.getSessionClient.mockReturnValue(client);

    let resolveSend: (() => void) | undefined;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    mockSessionService.sendSessionMessage.mockReturnValue(sendPromise);

    const dispatchPromise = chatMessageHandlerService.tryDispatchNextMessage('s1');

    await vi.waitFor(() => {
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    });

    expect(mockSessionDomainService.commitSentUserMessageAtOrder).toHaveBeenCalledWith(
      's1',
      queuedMessage,
      0
    );
    expect(mockSessionDomainService.emitDelta).not.toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'message_state_changed',
        id: 'm1',
        newState: 'COMMITTED',
      })
    );

    resolveSend?.();
    await dispatchPromise;

    expect(mockSessionDomainService.emitDelta).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'message_state_changed',
        id: 'm1',
        newState: 'COMMITTED',
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

  it('allows dispatch to resume after stop resets a stale in-progress guard', async () => {
    const secondQueuedMessage: QueuedMessage = {
      ...queuedMessage,
      id: 'm2',
      text: 'after stop',
      timestamp: '2026-02-01T00:00:01.000Z',
    };
    const client = {
      isCompactingActive: vi.fn().mockReturnValue(false),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    };
    mockSessionService.getSessionClient.mockReturnValue(client);
    mockSessionDomainService.peekNextMessage
      .mockReturnValueOnce(queuedMessage)
      .mockReturnValueOnce(secondQueuedMessage);
    mockSessionDomainService.dequeueNext
      .mockReturnValueOnce(queuedMessage)
      .mockReturnValueOnce(secondQueuedMessage);
    mockSessionDomainService.allocateOrder.mockReturnValueOnce(0).mockReturnValueOnce(1);

    let resolveFirstSend: (() => void) | undefined;
    const firstSendPromise = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });
    mockSessionService.sendSessionMessage
      .mockReturnValueOnce(firstSendPromise)
      .mockResolvedValueOnce(undefined);

    const firstDispatch = chatMessageHandlerService.tryDispatchNextMessage('s1');
    await vi.waitFor(() => {
      expect(mockSessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    });

    chatMessageHandlerService.resetDispatchState('s1');
    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionService.sendSessionMessage).toHaveBeenNthCalledWith(2, 's1', 'after stop');

    resolveFirstSend?.();
    await firstDispatch;
  });
});
