import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopSession: vi.fn(),
  clearPendingRequest: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
}));

vi.mock('@/backend/services/session/service/composition/session-core-services', () => ({
  sessionLifecycleService: {
    stopSession: mocks.stopSession,
  },
}));

vi.mock('@/backend/services/session/service/chat/chat-event-forwarder.service', () => ({
  chatEventForwarderService: {
    clearPendingRequest: mocks.clearPendingRequest,
  },
}));

import { createStopHandler } from './stop.handler';

describe('createStopHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops via provider-neutral lifecycle API and clears pending request', async () => {
    mocks.stopSession.mockResolvedValue(undefined);
    const handler = createStopHandler({
      lifecycle: { stopSession: mocks.stopSession },
      clearPendingRequest: mocks.clearPendingRequest,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
    });

    await handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, { type: 'stop' } as never);

    expect(mocks.stopSession).toHaveBeenCalledWith('session-1', { reason: 'USER_STOP' });
    expect(mocks.clearPendingRequest).toHaveBeenCalledWith('session-1');
    expect(mocks.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
  });

  it('waits for stopSession before retrying queued dispatch', async () => {
    let resolveStop!: () => void;
    mocks.stopSession.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveStop = resolve;
      })
    );
    const handler = createStopHandler({
      lifecycle: { stopSession: mocks.stopSession },
      clearPendingRequest: mocks.clearPendingRequest,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
    });

    const stopPromise = handler({ sessionId: 'session-1', workingDir: '/tmp/work' }, {
      type: 'stop',
    } as never);

    await Promise.resolve();

    expect(mocks.tryDispatchNextMessage).not.toHaveBeenCalled();

    resolveStop();
    await stopPromise;

    expect(mocks.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
  });
});
