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

vi.mock('@/backend/services/session/service/lifecycle/session-core-services', () => ({
  sessionLifecycleService: {
    getSessionOptions: mocks.getSessionOptions,
  },
}));

import { sessionBackgroundDeliveryService } from '@/backend/services/session/service/lifecycle/session-background-delivery.service';
import { createStartHandler } from './start.handler';

describe('createStartHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks runtime error when session options are missing', async () => {
    mocks.getSessionOptions.mockResolvedValue(null);
    const handler = createStartHandler({
      domain: { markError: mocks.markError },
      lifecycle: { getSessionOptions: mocks.getSessionOptions },
      backgroundDelivery: sessionBackgroundDeliveryService,
      startupService: {
        getSessionClient: vi.fn(),
        getOrCreateSessionClient: vi.fn(),
      },
    });

    const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp' }, {
      type: 'start',
    } as never);

    expect(mocks.markError).toHaveBeenCalledWith('session-1', 'Session not found');
    expect(outcome).toEqual({ replies: [{ type: 'error', error: { kind: 'session_not_found' } }] });
  });

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'does not start a client when workspace is %s',
    async (workspaceStatus) => {
      mocks.getSessionOptions.mockResolvedValue({
        workingDir: '/tmp/work',
        resumeProviderSessionId: undefined,
        model: 'sonnet',
        workspaceStatus,
      });
      const getOrCreate = vi.fn();
      const handler = createStartHandler({
        domain: { markError: mocks.markError },
        lifecycle: { getSessionOptions: mocks.getSessionOptions },
        backgroundDelivery: sessionBackgroundDeliveryService,
        startupService: {
          getSessionClient: vi.fn(),
          getOrCreateSessionClient: getOrCreate,
        },
      });

      const outcome = await handler({ sessionId: 'session-1', workingDir: '/tmp' }, {
        type: 'start',
      } as never);

      expect(getOrCreate).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        replies: [{ type: 'error', error: { kind: 'workspace_archived' } }],
      });
    }
  );
});

it('keeps the PR delivery fence when explicit startup fails', async () => {
  const resume = vi.spyOn(sessionBackgroundDeliveryService, 'userResume').mockResolvedValue();
  mocks.getSessionOptions.mockResolvedValue({ workspaceStatus: 'READY' });
  const startup = vi.fn().mockRejectedValue(new Error('provider unavailable'));
  try {
    await createStartHandler({
      domain: { markError: mocks.markError },
      lifecycle: { getSessionOptions: mocks.getSessionOptions },
      backgroundDelivery: sessionBackgroundDeliveryService,
      startupService: { getSessionClient: vi.fn(), getOrCreateSessionClient: startup },
    })({ sessionId: 'session-1', workingDir: '/tmp' }, { type: 'start' } as never);
    expect(resume).not.toHaveBeenCalled();
  } finally {
    resume.mockRestore();
  }
});

it('keeps a stop made while startup was pending after the old start finishes', async () => {
  const sessionId = 'pending-start-stop';
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pauseReason: string | null = null;
  sessionBackgroundDeliveryService.configure({
    prepare: () => Promise.resolve({ status: 'discard' }),
    validate: () => Promise.resolve(false),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve({ paused: false }),
    recover: () => Promise.resolve(),
    pause: (_id, reason) => {
      pauseReason = reason;
      return Promise.resolve();
    },
    resume: (_id, isCurrent?: () => boolean) => {
      if (!isCurrent || isCurrent()) {
        pauseReason = null;
      }
      return Promise.resolve();
    },
  });
  mocks.getSessionOptions.mockResolvedValue({ workspaceStatus: 'READY' });
  const startup = vi.fn().mockReturnValue(pending);
  const handler = createStartHandler({
    domain: { markError: mocks.markError },
    lifecycle: { getSessionOptions: mocks.getSessionOptions },
    backgroundDelivery: sessionBackgroundDeliveryService,
    startupService: { getSessionClient: vi.fn(), getOrCreateSessionClient: startup },
  });
  const start = handler({ sessionId, workingDir: '/tmp' }, { type: 'start' } as never);
  await vi.waitFor(() => expect(startup).toHaveBeenCalled());
  await sessionBackgroundDeliveryService.userStop(sessionId);
  release();
  await start;
  await Promise.resolve();
  expect(pauseReason).toBe('USER_STOPPED');
});
