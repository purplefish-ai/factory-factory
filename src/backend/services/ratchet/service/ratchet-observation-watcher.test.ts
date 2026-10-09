import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
  listPending: vi.fn(),
  markChecked: vi.fn(),
  register: vi.fn(),
  snapshot: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@/backend/services/job-runner.service', () => ({
  jobRunner: { register: mocks.register, start: vi.fn(), stop: vi.fn() },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: mocks,
  workspacePrSnapshotService: { list: mocks.snapshot },
}));

import {
  RatchetService,
  RATCHET_DISPATCH_CHANGED,
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
} from './ratchet.service';

beforeEach(() => {
  mocks.listEnabled.mockReset();
  mocks.listPending.mockReset().mockResolvedValue([]);
  mocks.markChecked.mockReset().mockResolvedValue(undefined);
  mocks.snapshot.mockReset().mockResolvedValue([]);
  mocks.get.mockReset().mockResolvedValue({ enabled: true, bindingRevision: 7 });
});

it('observes every association and wakes the main queue once without creating fixer sessions', async () => {
  mocks.listEnabled.mockResolvedValue([
    {
      workspaceId: 'w',
      enabled: true,
      workspace: {
        prs: [
          {
            id: 'p1',
            state: 'OPEN',
            ciStatus: 'FAILURE',
            hasMergeConflict: false,
            reviewState: null,
          },
          {
            id: 'p2',
            state: 'MERGED',
            ciStatus: 'SUCCESS',
            hasMergeConflict: false,
            reviewState: null,
          },
        ],
      },
    },
  ]);
  mocks.listPending.mockResolvedValue([]);
  const observe = vi.fn().mockResolvedValue(true),
    wake = vi.fn().mockResolvedValue(undefined);
  const ratchetService = new RatchetService();
  ratchetService.configure({ observe, wake, setMonitoring: vi.fn() });
  await ratchetService.checkAllWorkspaces();
  expect(observe.mock.calls.map((c) => c[0])).toEqual([
    { workspaceId: 'w', prId: 'p1' },
    { workspaceId: 'w', prId: 'p2' },
  ]);
  expect(wake).toHaveBeenCalledExactlyOnceWith('w');
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'pr-event-poll', intervalMs: 120_000 })
  );
  observe.mockClear().mockImplementation((target) => {
    if (target.prId === 'p1') {
      return Promise.reject(new Error('Repository is inaccessible'));
    }
    return Promise.resolve(true);
  });
  wake.mockClear();
  await ratchetService.checkAllWorkspaces();
  expect(observe.mock.calls.map((c) => c[0].prId)).toEqual(['p1', 'p2']);
  expect(wake).toHaveBeenCalledExactlyOnceWith('w');
  observe.mockClear().mockRejectedValue(new Error('HTTP 429 rate limit'));
  wake.mockClear();
  await ratchetService.checkAllWorkspaces();
  expect(observe).toHaveBeenCalledTimes(1);
  expect(wake).toHaveBeenCalledExactlyOnceWith('w');
});

const config = {
  workspaceId: 'w',
  enabled: true,
  workspace: {
    prs: [
      { id: 'p1', state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: false, reviewState: null },
    ],
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['all', 'single'] as const)(
  'does not begin %s workspace checks after stopping during the query',
  async (scope) => {
    const loaded = deferred<(typeof config)[]>();
    mocks.listEnabled.mockReturnValue(loaded.promise);
    const observe = vi.fn().mockResolvedValue(true);
    const wake = vi.fn().mockResolvedValue(undefined);
    const service = new RatchetService();
    service.configure({ observe, wake, setMonitoring: vi.fn() });
    const checking =
      scope === 'all' ? service.checkAllWorkspaces() : service.checkWorkspaceById('w');
    await service.stop();
    loaded.resolve([config]);
    await checking;
    expect(observe).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  }
);

it.each([
  { deliveryMode: 'DEDICATED' as const },
  { resume: true },
  { recipientSessionId: 'replacement' },
])('refreshes monitoring projection without a false state reset for %j', async (options) => {
  const service = new RatchetService();
  const setMonitoring = vi.fn().mockResolvedValue({ status: 'updated', bindingRevision: 8 });
  service.configure({ observe: vi.fn(), wake: vi.fn(), setMonitoring });
  const toggled = vi.fn(),
    changed = vi.fn();
  service.on(RATCHET_TOGGLED, toggled);
  service.on(RATCHET_DISPATCH_CHANGED, changed);
  await service.setWorkspaceRatcheting('w', true, { ...options, expectedBindingRevision: 7 });
  expect(toggled).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w' });
});

it.each([false, true])('publishes only an actual enablement transition to %s', async (enabled) => {
  mocks.get.mockResolvedValue({ enabled: !enabled, bindingRevision: 7 });
  const service = new RatchetService();
  const setMonitoring = vi.fn().mockResolvedValue({ status: 'updated', bindingRevision: 8 });
  service.configure({ observe: vi.fn(), wake: vi.fn(), setMonitoring });
  const toggled = vi.fn(),
    changed = vi.fn();
  service.on(RATCHET_TOGGLED, toggled);
  service.on(RATCHET_DISPATCH_CHANGED, changed);
  await service.setWorkspaceRatcheting('w', enabled);
  expect(toggled).toHaveBeenCalledExactlyOnceWith({
    workspaceId: 'w',
    enabled,
    ratchetState: 'IDLE',
  });
  expect(changed).not.toHaveBeenCalled();
});

it('preserves the displayed revision rather than substituting the latest one', async () => {
  const service = new RatchetService();
  const setMonitoring = vi.fn().mockRejectedValue(new Error('revision changed'));
  service.configure({ observe: vi.fn(), wake: vi.fn(), setMonitoring });
  const toggled = vi.fn(),
    changed = vi.fn();
  service.on(RATCHET_TOGGLED, toggled);
  service.on(RATCHET_DISPATCH_CHANGED, changed);
  await expect(
    service.setWorkspaceRatcheting('w', true, { expectedBindingRevision: 6 })
  ).rejects.toThrow('revision changed');
  expect(setMonitoring).toHaveBeenCalledWith(
    expect.objectContaining({ expectedBindingRevision: 6 })
  );
  expect(toggled).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});
it.each(['markChecked', 'listPending', 'wake', 'snapshot'] as const)(
  'does not continue delivery or publish state after stopping during %s',
  async (stage) => {
    mocks.listEnabled.mockResolvedValue([config]);
    const entered = deferred<void>();
    const release = deferred<[]>();
    const observe = vi.fn().mockResolvedValue(true);
    const wake = vi.fn().mockResolvedValue(undefined);
    const paused = stage === 'wake' ? wake : mocks[stage];
    paused.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const service = new RatchetService();
    service.configure({ observe, wake, setMonitoring: vi.fn() });
    const dispatchChanged = vi.fn(),
      stateChanged = vi.fn();
    service.on(RATCHET_DISPATCH_CHANGED, dispatchChanged);
    service.on(RATCHET_STATE_CHANGED, stateChanged);
    const checking = service.checkAllWorkspaces();
    await entered.promise;
    await service.stop();
    release.resolve([]);
    await checking;
    if (stage === 'markChecked' || stage === 'listPending') {
      expect(wake).not.toHaveBeenCalled();
    }
    if (stage !== 'snapshot') {
      expect(dispatchChanged).not.toHaveBeenCalled();
    }
    expect(stateChanged).not.toHaveBeenCalled();
  }
);
