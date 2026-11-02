import { expect, it, vi } from 'vitest';
import { createDeferred, createTerminationHarness } from './session-lifecycle.test-helpers';
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
  const gate = createDeferred<{
    version: 1;
    cause: 'TIMEOUT';
    source: null;
    status: 'UNKNOWN';
    observedAt: string;
  }>();
  const stopAndQuiesceObserved = vi.fn(() => gate.promise);
  const coordinator = new SessionTerminationCoordinator({
    ...base,
    eventAuthority: authority as never,
    runtimeManager: { ...base.runtimeManager, stopAndQuiesceObserved },
  });
  const first = coordinator.interruptEventInitial(base.session.id, 'TIMEOUT');
  await vi.waitFor(() => expect(stopAndQuiesceObserved).toHaveBeenCalledOnce());
  let rejected = false;
  const second = coordinator
    .interruptEventInitial(base.session.id, 'SHUTDOWN')
    .catch((error: unknown) => {
      rejected = true;
      return error;
    });
  try {
    await vi.waitFor(() => expect(rejected).toBe(true));
    expect(await second).toMatchObject({ message: 'Event stop confirmation is pending' });
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
    await Promise.all([first, second]);
  }
  expect(authority.recordStop).toHaveBeenCalledOnce();
  expect(authority.recordStop).toHaveBeenCalledWith(
    base.session.id,
    expect.objectContaining({ cause: 'TIMEOUT' }),
    expect.any(AbortSignal)
  );
  expect(base.lifecycleGate.isStopReserved(base.session.id)).toBe(false);
});
