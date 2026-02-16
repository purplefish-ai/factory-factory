import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stopSession: vi.fn(),
  clearPendingRequest: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
}));

vi.mock('@/backend/domains/session/lifecycle/session.service', () => ({
  sessionService: {
    stopSession: mocks.stopSession,
  },
}));

vi.mock('@/backend/domains/session/chat/chat-event-forwarder.service', () => ({
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
      getClientCreator: () => null,
      tryDispatchNextMessage: mocks.tryDispatchNextMessage,
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: { send: vi.fn() } as never,
      sessionId: 'session-1',
      workingDir: '/tmp/work',
      message: { type: 'stop' } as never,
    });

    expect(mocks.stopSession).toHaveBeenCalledWith('session-1');
    expect(mocks.clearPendingRequest).toHaveBeenCalledWith('session-1');
    expect(mocks.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
  });
});
