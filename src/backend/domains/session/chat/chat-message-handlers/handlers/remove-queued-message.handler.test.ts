import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/acp-protocol';

const mocks = vi.hoisted(() => ({
  removeQueuedMessage: vi.fn(),
  emitDelta: vi.fn(),
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    removeQueuedMessage: mocks.removeQueuedMessage,
    emitDelta: mocks.emitDelta,
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createRemoveQueuedMessageHandler } from './remove-queued-message.handler';

describe('createRemoveQueuedMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits cancelled state when queued message is removed', () => {
    mocks.removeQueuedMessage.mockReturnValue(true);
    const ws = { send: vi.fn() };
    const handler = createRemoveQueuedMessageHandler();

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'remove_queued_message', messageId: 'msg-1' } as never,
    });

    expect(mocks.removeQueuedMessage).toHaveBeenCalledWith('session-1', 'msg-1');
    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'message_state_changed',
      id: 'msg-1',
      newState: MessageState.CANCELLED,
    });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends error when message id is not in queue', () => {
    mocks.removeQueuedMessage.mockReturnValue(false);
    const ws = { send: vi.fn() };
    const handler = createRemoveQueuedMessageHandler();

    void handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'remove_queued_message', messageId: 'missing' } as never,
    });

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Message not found in queue' })
    );
  });
});
