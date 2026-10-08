import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
  listPending: vi.fn(),
  markChecked: vi.fn(),
  register: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('@/backend/services/job-runner.service', () => ({
  jobRunner: { register: mocks.register, start: vi.fn(), stop: vi.fn() },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: mocks,
  workspacePrSnapshotService: { list: mocks.snapshot },
}));

import { RatchetService, RATCHET_DISPATCH_CHANGED, RATCHET_STATE_CHANGED } from './ratchet.service';

beforeEach(() => {
  mocks.listEnabled.mockReset();
  mocks.listPending.mockReset().mockResolvedValue([]);
  mocks.markChecked.mockReset().mockResolvedValue(undefined);
  mocks.snapshot.mockReset().mockResolvedValue([]);
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
