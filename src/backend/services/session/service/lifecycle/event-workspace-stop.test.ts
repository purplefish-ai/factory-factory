import { afterEach, expect, it, vi } from 'vitest';
import { createTerminationHarness } from './session-lifecycle.test-helpers';
import { SessionTerminationCoordinator } from './session-termination.coordinator';
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => logger,
  getCurrentProcessEnv: () => ({ NODE_ENV: 'test' }),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each(['reject', 'stall'] as const)(
  'continues workspace cleanup after a %s ownership read',
  async (kind) => {
    vi.useFakeTimers();
    const base = createTerminationHarness();
    base.repository.getSessionsByWorkspaceId.mockResolvedValue([
      { ...base.session, id: 'uncertain', status: 'IDLE' },
      { ...base.session, id: 'remaining', status: 'RUNNING' },
    ]);
    base.runtimeManager.isSessionRunning.mockReturnValue(false);
    base.runtimeManager.hasClientCreationOperation.mockReturnValue(false);
    const authority = {
      isOwned: (id: string) =>
        id === 'uncertain'
          ? kind === 'stall'
            ? new Promise<boolean>(() => undefined)
            : Promise.reject(new Error('unavailable'))
          : Promise.resolve(false),
      invalidate: vi.fn(),
    };
    const coordinator = new SessionTerminationCoordinator({
      ...base,
      eventAuthority: authority as never,
    });
    try {
      const stopping = expect(coordinator.stopWorkspaceSessions('workspace')).rejects.toThrow(
        'Failed to stop 1 workspace session'
      );
      await vi.runAllTimersAsync();
      await stopping;
      expect(base.runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('uncertain');
      expect(base.runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('remaining');
    } finally {
      vi.useRealTimers();
    }
  }
);
it.each(['SENDING', 'FINISHED'] as const)(
  'selects the expected runtime source for %s delivery',
  async (state) => {
    const base = createTerminationHarness();
    const source = {
      version: 1,
      provider: 'CLAUDE',
      providerSessionId: 'native',
      runtimeIncarnationId: 'initial',
      lifecycleGeneration: 1,
    };
    const authority = {
      isOwned: async () => true,
      invalidate: vi.fn(),
      read: async () => ({ state, evidence: { source } }),
      recordStop: async () => undefined,
    };
    const stopAndQuiesceObserved = vi.fn(async () => ({
      version: 1 as const,
      cause: 'USER_STOP' as const,
      status: 'LOCAL_RUNTIME_GROUP_STOPPED' as const,
      source: null,
      observedAt: new Date().toISOString(),
    }));
    const coordinator = new SessionTerminationCoordinator({
      ...base,
      eventAuthority: authority as never,
      runtimeManager: { ...base.runtimeManager, stopAndQuiesceObserved },
    });
    await coordinator.stopSession(base.session.id, { reason: 'USER_STOP' });
    expect(stopAndQuiesceObserved).toHaveBeenCalledWith(
      base.session.id,
      'USER_STOP',
      state === 'FINISHED' ? undefined : source
    );
  }
);
it('inactive lookup failure cleans physical ownership without fabricating a recovered ordinary user stop', async () => {
  const base = createTerminationHarness();
  base.repository.getSessionsByWorkspaceId.mockResolvedValue([{ ...base.session, status: 'IDLE' }]);
  base.runtimeManager.isSessionRunning.mockReturnValue(false);
  base.runtimeManager.hasClientCreationOperation.mockReturnValue(false);
  const authority = {
    isOwned: vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(false),
    invalidate: vi.fn(),
  };
  const coordinator = new SessionTerminationCoordinator({
    ...base,
    eventAuthority: authority as never,
  });
  await expect(
    coordinator.stopWorkspaceSessions('workspace', { reason: 'USER_STOP' })
  ).rejects.toThrow('Failed to stop 1');
  expect(authority.invalidate).toHaveBeenCalledWith(base.session.id);
  expect(base.runtimeManager.stopAndQuiesce).toHaveBeenCalledWith(base.session.id);
  expect(base.lifecycleEventService.record).not.toHaveBeenCalled();
  expect(base.workflowFinalizer.finalizeDeliberateStop).not.toHaveBeenCalled();
  expect(base.repository.updateSessionIfStatus).not.toHaveBeenCalled();
});

it.each(['reject', 'timeout'] as const)(
  'reports inactive fallback cleanup %s without leaking failure text',
  async (failure) => {
    vi.useFakeTimers();
    const base = createTerminationHarness();
    base.repository.getSessionsByWorkspaceId.mockResolvedValue([
      { ...base.session, status: 'IDLE' },
    ]);
    base.runtimeManager.isSessionRunning.mockReturnValue(false);
    base.runtimeManager.hasClientCreationOperation.mockReturnValue(false);
    base.runtimeManager.stopAndQuiesce.mockImplementation(() =>
      failure === 'reject'
        ? Promise.reject(new Error('credential-bearing secret'))
        : new Promise<void>(() => undefined)
    );
    const authority = {
      isOwned: vi.fn().mockRejectedValue(new Error('owner unavailable')),
      invalidate: vi.fn(),
    };
    const coordinator = new SessionTerminationCoordinator({
      ...base,
      eventAuthority: authority as never,
    });
    const stopped = expect(
      coordinator.stopWorkspaceSessions('workspace', { reason: 'USER_STOP' })
    ).rejects.toThrow('Failed to stop 1');
    await vi.runAllTimersAsync();
    await stopped;
    expect(authority.invalidate).toHaveBeenCalledWith(base.session.id);
    expect(logger.warn).toHaveBeenCalledWith(
      'Physical runtime cleanup failed after ownership lookup failure',
      { sessionId: base.session.id }
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to stop workspace session',
      expect.objectContaining({ error: 'owner unavailable' })
    );
    expect(base.lifecycleEventService.record).not.toHaveBeenCalled();
    expect(base.workflowFinalizer.finalizeDeliberateStop).not.toHaveBeenCalled();
  }
);
