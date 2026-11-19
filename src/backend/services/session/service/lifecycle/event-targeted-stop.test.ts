import { expect, it, vi } from 'vitest';
import { createDeferredCall, createTerminationHarness } from './session-lifecycle.test-helpers';
import { SessionTerminationCoordinator } from './session-termination.coordinator';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: { listPendingForDelivery: vi.fn(), markDelivered: vi.fn() },
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ defaultWorkspacePermissions: 'STRICT' })) },
}));

it('rejects a second targeted interruption while the first reservation owns stop evidence', async () => {
  const base = createTerminationHarness();
  const authority = {
    isOwned: async () => true,
    invalidate: vi.fn(),
    read: async () => null,
    recordStop: vi.fn(async () => undefined),
  };
  const gate = createDeferredCall<{
    version: 1;
    cause: 'TIMEOUT';
    source: null;
    status: 'UNKNOWN';
    observedAt: string;
  }>();
  const stopAndQuiesceObserved = vi.fn(gate.run);
  const coordinator = new SessionTerminationCoordinator({
    ...base,
    eventAuthority: authority as never,
    runtimeManager: { ...base.runtimeManager, stopAndQuiesceObserved },
  });
  const first = coordinator.interruptEventInitial(base.session.id, 'TIMEOUT');
  await gate.entered;
  expect(stopAndQuiesceObserved).toHaveBeenCalledOnce();
  const second = coordinator.interruptEventInitial(base.session.id, 'SHUTDOWN');
  try {
    await expect(second).rejects.toMatchObject({ message: 'Event stop confirmation is pending' });
    expect(base.lifecycleGate.isStopReserved(base.session.id)).toBe(true);
    expect(stopAndQuiesceObserved).toHaveBeenCalledOnce();
    expect(authority.recordStop).not.toHaveBeenCalled();
  } finally {
    gate.resolve({
      version: 1,
      cause: 'TIMEOUT',
      source: null,
      status: 'UNKNOWN',
      observedAt: new Date().toISOString(),
    });
    await Promise.all([first, second.catch(() => undefined)]);
  }
  expect(authority.recordStop).toHaveBeenCalledOnce();
  expect(authority.recordStop).toHaveBeenCalledWith(
    base.session.id,
    expect.objectContaining({ cause: 'TIMEOUT' }),
    expect.any(AbortSignal)
  );
  expect(base.lifecycleGate.isStopReserved(base.session.id)).toBe(false);
});
