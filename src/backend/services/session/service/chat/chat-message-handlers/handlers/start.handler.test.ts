import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionOptions: vi.fn(),
  markError: vi.fn(),
}));

vi.mock('@/backend/services/session/service/session-domain.service', () => ({
  sessionDomainService: {
    markError: mocks.markError,
  },
}));

vi.mock('@/backend/services/session/service/lifecycle/session.service', () => ({
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

    expect(mocks.markError).toHaveBeenCalledWith('session-1', 'Session not found');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'error', message: 'Session not found' })
    );
  });

  it.each([
    'ARCHIVING',
    'ARCHIVED',
  ] as const)('does not start a client when workspace is %s', async (workspaceStatus) => {
    mocks.getSessionOptions.mockResolvedValue({
      workingDir: '/tmp/work',
      resumeProviderSessionId: undefined,
      systemPrompt: undefined,
      model: 'sonnet',
      workspaceStatus,
    });
    const getOrCreate = vi.fn();
    const ws = { send: vi.fn() } as unknown as { send: (message: string) => void };
    const handler = createStartHandler({
      getClientCreator: () => ({
        getOrCreate,
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

    expect(getOrCreate).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'error',
        message: 'Workspace is archived or archiving and cannot start sessions.',
      })
    );
  });
});
