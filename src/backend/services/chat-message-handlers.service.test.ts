import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@/shared/claude';

const { mockSessionDomainService, mockSessionService } = vi.hoisted(() => ({
  mockSessionDomainService: {
    dequeueNext: vi.fn(),
    requeueFront: vi.fn(),
    markIdle: vi.fn(),
    markRunning: vi.fn(),
    allocateOrder: vi.fn(),
    emitDelta: vi.fn(),
    commitSentUserMessageAtOrder: vi.fn(),
    getQueueLength: vi.fn(),
  },
  mockSessionService: {
    getClient: vi.fn(),
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: mockSessionDomainService,
}));

vi.mock('./session.service', () => ({
  sessionService: mockSessionService,
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
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionDomainService.dequeueNext.mockReturnValue(queuedMessage);
    mockSessionDomainService.allocateOrder.mockReturnValue(0);
  });

  it('reverts runtime to idle when dispatch fails after markRunning', async () => {
    const client = {
      isWorking: vi.fn().mockReturnValue(false),
      isRunning: vi.fn().mockReturnValue(true),
      isCompactingActive: vi.fn().mockReturnValue(false),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
    };
    mockSessionService.getClient.mockReturnValue(client);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
    expect(mockSessionDomainService.markIdle).toHaveBeenCalledWith('s1', 'alive');
    expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
  });

  it('does not call markIdle when process has already stopped during dispatch failure', async () => {
    const client = {
      isWorking: vi.fn().mockReturnValue(false),
      isRunning: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
      isCompactingActive: vi.fn().mockReturnValue(false),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
      startCompaction: vi.fn(),
      endCompaction: vi.fn(),
    };
    mockSessionService.getClient.mockReturnValue(client);

    await chatMessageHandlerService.tryDispatchNextMessage('s1');

    expect(mockSessionDomainService.markRunning).toHaveBeenCalledWith('s1');
    expect(mockSessionDomainService.markIdle).not.toHaveBeenCalled();
    expect(mockSessionDomainService.requeueFront).toHaveBeenCalledWith('s1', queuedMessage);
  });
});
