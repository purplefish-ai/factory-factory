import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageState } from '@/shared/acp-protocol';

const mocks = vi.hoisted(() => ({
  removeQueuedMessage: vi.fn(),
  emitDelta: vi.fn(),
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
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
    const handler = createRemoveQueuedMessageHandler({ domain: mocks });

    const outcome = handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'remove_queued_message',
      messageId: 'msg-1',
    } as never);

    expect(mocks.removeQueuedMessage).toHaveBeenCalledWith('session-1', 'msg-1');
    expect(mocks.emitDelta).toHaveBeenCalledWith('session-1', {
      type: 'message_state_changed',
      id: 'msg-1',
      newState: MessageState.CANCELLED,
    });
    expect(outcome).toEqual({ replies: [] });
  });

  it('sends error when message id is not in queue', () => {
    mocks.removeQueuedMessage.mockReturnValue(false);
    const handler = createRemoveQueuedMessageHandler({ domain: mocks });

    const outcome = handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'remove_queued_message',
      messageId: 'missing',
    } as never);

    expect(outcome).toEqual({
      replies: [{ type: 'error', error: { kind: 'message_not_queued' } }],
    });
  });
});
