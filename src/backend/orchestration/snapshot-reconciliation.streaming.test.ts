import { expect, it, vi } from 'vitest';
import {
  deriveWorkspaceFlowState,
  type SnapshotUpdateInput,
  WorkspaceSnapshotStore,
} from '@/backend/services/workspace';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { SnapshotReconciliationService } from './snapshot-reconciliation.orchestrator';

type GitStats = NonNullable<SnapshotUpdateInput['gitStats']>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeWorkspace(id: string, worktreePath: string | null) {
  return {
    id,
    projectId: 'project-1',
    name: `Workspace ${id}`,
    status: 'READY',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    branchName: `feature/${id}`,
    hasHadSessions: false,
    worktreePath,
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    ratchetEnabled: false,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
    ratchetDispatchStalled: false,
    prHasMergeConflict: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
    runScriptStatus: 'IDLE',
    agentSessions: [],
    terminalSessions: [],
    project: { defaultBranch: 'main' },
  };
}

function makeService(
  workspaces: ReturnType<typeof makeWorkspace>[],
  getWorkspaceGitStats: (path: string) => Promise<GitStats | null>,
  workspaceSnapshotStore: {
    getAllWorkspaceIds(): string[];
    getByWorkspaceId(id: string): unknown;
    remove(id: string): boolean;
    upsert(
      id: string,
      update: SnapshotUpdateInput,
      source: string,
      timestamp: number
    ): {
      accepted: boolean;
      changed: boolean;
      emitted: boolean;
    };
  }
) {
  return new SnapshotReconciliationService({
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    gitOpsService: { getWorkspaceGitStats },
    session: {
      getAllPendingRequests: () => new Map(),
      getRuntimeSnapshot: () => ({
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    workspaceMaintenanceService: {
      findActiveWithSessionsAndProject: vi.fn().mockResolvedValue(workspaces),
    },
    workspaceSnapshotStore,
  } as never);
}

function createStore() {
  const store = new WorkspaceSnapshotStore();
  store.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
  });
  return store;
}

it('makes the database seed available while preserving cached git stats', async () => {
  const cachedGitStats = { total: 2, additions: 1, deletions: 1, hasUncommitted: false };
  const freshGitStats = { total: 4, additions: 3, deletions: 1, hasUncommitted: true };
  const pendingGitStats = deferred<GitStats>();
  const store = createStore();
  store.upsert('ws-1', { projectId: 'project-1', gitStats: cachedGitStats }, 'seed', 100);
  const service = makeService(
    [makeWorkspace('ws-1', '/path/1')],
    () => pendingGitStats.promise,
    store
  );

  service.start();
  try {
    await service.waitForSeed();
    expect(store.getByWorkspaceId('ws-1')).toMatchObject({
      name: 'Workspace ws-1',
      gitStats: cachedGitStats,
    });
  } finally {
    pendingGitStats.resolve(freshGitStats);
    await service.stop();
  }

  expect(store.getByWorkspaceId('ws-1')?.gitStats).toEqual(freshGitStats);
});

it.each([
  {
    failure: 'a null result',
    readGitStats: () => Promise.resolve(null),
  },
  {
    failure: 'a rejected read',
    readGitStats: () => Promise.reject(new Error('git unavailable')),
  },
])('preserves cached git stats after $failure', async ({ readGitStats }) => {
  const cachedGitStats = { total: 6, additions: 4, deletions: 2, hasUncommitted: true };
  const store = createStore();
  store.upsert('ws-1', { projectId: 'project-1', gitStats: cachedGitStats }, 'seed', 100);
  const service = makeService([makeWorkspace('ws-1', '/path/1')], readGitStats, store);

  await service.reconcile();

  expect(store.getByWorkspaceId('ws-1')?.gitStats).toEqual(cachedGitStats);
});

it('keeps null git stats when a first read fails without a cached value', async () => {
  const store = createStore();
  const service = makeService(
    [makeWorkspace('ws-1', '/path/1')],
    () => Promise.resolve(null),
    store
  );

  await service.reconcile();

  expect(store.getByWorkspaceId('ws-1')?.gitStats).toBeNull();
});

it('clears cached git stats when the workspace no longer has a worktree', async () => {
  const cachedGitStats = { total: 6, additions: 4, deletions: 2, hasUncommitted: true };
  const store = createStore();
  store.upsert('ws-1', { projectId: 'project-1', gitStats: cachedGitStats }, 'seed', 100);
  const readGitStats = vi.fn<() => Promise<GitStats>>();
  const service = makeService([makeWorkspace('ws-1', null)], readGitStats, store);

  await service.reconcile();

  expect(store.getByWorkspaceId('ws-1')?.gitStats).toBeNull();
  expect(readGitStats).not.toHaveBeenCalled();
});

it('releases the seed barrier when there are no workspaces', async () => {
  const upsert = vi.fn();
  const service = makeService([], vi.fn(), {
    getAllWorkspaceIds: () => [],
    getByWorkspaceId: () => undefined,
    remove: () => false,
    upsert,
  });

  service.start();
  await service.waitForSeed();
  await service.stop();

  expect(upsert).not.toHaveBeenCalled();
});

it('keeps shutdown pending until streamed git work settles', async () => {
  const pendingGitStats = deferred<GitStats>();
  const service = makeService([makeWorkspace('ws-1', '/path/1')], () => pendingGitStats.promise, {
    getAllWorkspaceIds: () => [],
    getByWorkspaceId: () => undefined,
    remove: () => false,
    upsert: () => ({ accepted: true, changed: true, emitted: true }),
  });
  service.start();
  await service.waitForSeed();

  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);

  pendingGitStats.resolve({ total: 2, additions: 1, deletions: 1, hasUncommitted: false });
  await stopping;
  expect(stopped).toBe(true);
});

it('publishes each git result as it settles and keeps accurate accounting', async () => {
  const first = deferred<GitStats>();
  const second = deferred<GitStats>();
  const upsert = vi.fn<
    (
      id: string,
      update: SnapshotUpdateInput,
      source: string,
      timestamp: number
    ) => { accepted: boolean; changed: boolean; emitted: boolean }
  >(() => ({ accepted: true, changed: true, emitted: true }));
  const store = {
    getAllWorkspaceIds: () => [],
    getByWorkspaceId: () => undefined,
    remove: () => false,
    upsert,
  };
  const service = makeService(
    [makeWorkspace('ws-1', '/path/1'), makeWorkspace('ws-2', '/path/2')],
    (path) => (path === '/path/1' ? first.promise : second.promise),
    store
  );

  const reconciliation = service.reconcile();
  await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(2));
  second.resolve({ total: 4, additions: 3, deletions: 1, hasUncommitted: true });
  await vi.waitFor(() =>
    expect(upsert).toHaveBeenCalledWith(
      'ws-2',
      { gitStats: { total: 4, additions: 3, deletions: 1, hasUncommitted: true } },
      'reconciliation',
      expect.any(Number)
    )
  );
  expect(upsert).toHaveBeenCalledTimes(3);

  first.resolve({ total: 2, additions: 1, deletions: 1, hasUncommitted: false });
  const result = await reconciliation;
  expect(result).toMatchObject({ workspacesChanged: 2, deltasEmitted: 4, gitStatsComputed: 2 });
  expect(new Set(upsert.mock.calls.map((call) => call[3]))).toHaveLength(1);
});

it('accepts git stats at the same timestamp as the activity seed', () => {
  const store = createStore();
  store.upsert(
    'ws-1',
    {
      projectId: 'project-1',
      gitStats: { total: 2, additions: 1, deletions: 1, hasUncommitted: false },
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    },
    'seed',
    100
  );
  store.upsert('ws-1', { lastActivityAt: '2026-01-02T00:00:00.000Z' }, 'reconciliation', 200);

  const result = store.upsert(
    'ws-1',
    { gitStats: { total: 5, additions: 4, deletions: 1, hasUncommitted: true } },
    'reconciliation',
    200
  );

  expect(result).toEqual({ accepted: true, changed: true, emitted: true });
  expect(store.getByWorkspaceId('ws-1')).toMatchObject({
    gitStats: { total: 5, additions: 4, deletions: 1, hasUncommitted: true },
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    fieldTimestamps: { git: 200, reconciliation: 200 },
  });
});

it('does not let a newer session-only event suppress an activity seed', () => {
  const store = createStore();
  store.upsert(
    'ws-1',
    { projectId: 'project-1', lastActivityAt: '2026-01-01T00:00:00.000Z' },
    'seed',
    100
  );
  store.upsert('ws-1', { isWorking: true }, 'session-event', 300);

  const result = store.upsert(
    'ws-1',
    { lastActivityAt: '2026-01-02T00:00:00.000Z' },
    'reconciliation',
    200
  );

  expect(result).toEqual({ accepted: true, changed: true, emitted: true });
  expect(store.getByWorkspaceId('ws-1')).toMatchObject({
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    fieldTimestamps: { session: 300, reconciliation: 200 },
  });
});
