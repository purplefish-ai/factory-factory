import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionOptions: vi.fn(),
  markError: vi.fn(),
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    markError: mocks.markError,
  },
}));

vi.mock('../../../lifecycle/session.service', () => ({
  sessionService: {
    getSessionOptions: mocks.getSessionOptions,
  },
}));

import { createStartHandler } from './start.handler';

describe('createStartHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks runtime error when session options are missing', async () => {
    mocks.getSessionOptions.mockResolvedValue(null);
    const ws = { send: vi.fn() } as unknown as { send: (message: string) => void };
    const handler = createStartHandler({
      getClientCreator: () => ({
        getOrCreate: vi.fn(),
      }),
      tryDispatchNextMessage: vi.fn(),
      setManualDispatchResume: vi.fn(),
    });

    await handler({
      ws: ws as never,
      sessionId: 'session-1',
      workingDir: '/tmp',
      message: {
        type: 'start',
      } as never,
    });

    expect(mocks.markError).toHaveBeenCalledWith('session-1');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Session not found' })
    );
  });
});
