import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
  workspaceDetailQueryOptions,
  workspaceDetailCacheOptions,
} from '@/client/lib/workspace-cache-reconciler';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

const clients: QueryClient[] = [];
function detail(overrides: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
  return unsafeCoerce<WorkspaceDetail>({
    ...projectSnapshotToWorkspace(entry()),
    hasHadSessions: false,
    prUpdatedAt: null,
    initOutput: 'Setup output',
    initStartedAt: new Date('2026-01-01'),
    initCompletedAt: new Date('2026-01-02'),
    defaultSessionProvider: 'CODEX',
    agentSessions: [{ id: 'agent-1', provider: 'CODEX' }],
    terminalSessions: [{ id: 'terminal-1', name: 'Shell' }],
    ...overrides,
  });
}
function fixture(projectId = 'proj-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const owner = getProjectWorkspaceCacheReconciler(client, projectId);
  const token = owner.beginConnection();
  let resolve!: (value: WorkspaceDetail) => void;
  const options = workspaceDetailQueryOptions(
    client,
    'ws-1',
    () =>
      new Promise<WorkspaceDetail>((done) => {
        resolve = done;
      })
  );
  const full = (entries = [entry()]) =>
    owner.apply(token, { type: 'snapshot_full', projectId, entries });
  return {
    client,
    owner,
    token,
    options,
    full,
    resolve: (value: WorkspaceDetail) => resolve(value),
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

describe('workspace detail HTTP/stream commit ownership', () => {
  it('overlays the latest accepted entry at commit while hydrating detail-only fields', async () => {
    const f = fixture();
    const pending = f.client.fetchQuery(f.options);
    f.full();
    f.resolve(
      detail({ name: 'HTTP', worktreePath: '/ready/path', initErrorMessage: 'Setup warning' })
    );
    await Promise.resolve();
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({
        name: 'Newest',
        status: 'READY',
        runScriptStatus: 'RUNNING',
        hasHadSessions: true,
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'PAUSED',
        pendingRequestType: 'plan_approval',
      }),
    });
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      name: 'Newest',
      status: 'READY',
      runScriptStatus: 'RUNNING',
      hasHadSessions: true,
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'PAUSED',
      pendingRequestType: 'plan_approval',
      worktreePath: '/ready/path',
      initErrorMessage: 'Setup warning',
      initOutput: 'Setup output',
      initStartedAt: new Date('2026-01-01'),
      initCompletedAt: new Date('2026-01-02'),
      defaultSessionProvider: 'CODEX',
      agentSessions: [{ id: 'agent-1', provider: 'CODEX' }],
      terminalSessions: [{ id: 'terminal-1', name: 'Shell' }],
    });
  });

  it('retains accepted deltas before a full baseline without granting list membership authority', async () => {
    const f = fixture();
    const pending = f.client.fetchQuery(f.options);
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'Delta' }),
    });
    f.resolve(detail({ name: 'HTTP' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Delta' });
    await f.client.fetchQuery({
      ...projectWorkspaceQueryOptions(f.client, 'proj-1', () =>
        Promise.resolve({ workspaces: [], reviewCount: 0 })
      ),
      staleTime: 0,
    });
    expect(f.client.getQueryData(f.owner.queryKey)).toMatchObject({ workspaces: [] });
  });

  it('keeps absent full detail absent until HTTP supplies the fetched row', async () => {
    const f = fixture();
    f.full();
    expect(f.client.getQueryData(f.options.queryKey)).toBeUndefined();
    expect(f.client.getQueryCache().find({ queryKey: f.options.queryKey })).toBeUndefined();
    const pending = f.client.fetchQuery(f.options);
    expect(f.client.getQueryData(f.options.queryKey)).toBeUndefined();
    f.resolve(detail({ worktreePath: '/hydrated' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ worktreePath: '/hydrated' });
  });

  it('accepts initial HTTP that starts before the project connection is created', async () => {
    const client = new QueryClient();
    clients.push(client);
    let resolve!: (value: WorkspaceDetail) => void;
    const options = workspaceDetailQueryOptions(
      client,
      'ws-1',
      () =>
        new Promise<WorkspaceDetail>((done) => {
          resolve = done;
        })
    );
    const pending = client.fetchQuery(options);
    const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
    const token = owner.beginConnection();
    owner.apply(token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'First stream' })],
    });
    resolve(detail({ name: 'HTTP' }));
    await pending;
    expect(client.getQueryData(options.queryKey)).toMatchObject({ name: 'First stream' });
  });

  it('ignores HTTP from a retired project generation and accepts fresh HTTP fallback', async () => {
    const f = fixture();
    f.client.setQueryData(f.options.queryKey, detail({ name: 'Cached' }));
    const pending = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.owner.retireConnection(f.token);
    f.resolve(detail({ name: 'Retired' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Cached' });
    const fallback = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(detail({ name: 'Fallback' }));
    await fallback;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Fallback' });
  });

  it('rejects pre-connection HTTP after that first connection has retired', async () => {
    const client = new QueryClient();
    clients.push(client);
    let resolve!: (value: WorkspaceDetail) => void;
    const options = workspaceDetailQueryOptions(
      client,
      'ws-1',
      () =>
        new Promise<WorkspaceDetail>((done) => {
          resolve = done;
        })
    );
    const pending = client.fetchQuery(options);
    const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
    const token = owner.beginConnection();
    owner.retireConnection(token);
    owner.beginConnection();
    resolve(detail({ name: 'Retired bootstrap' }));
    await pending;
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  });

  it.each([
    {
      responseProject: 'proj-1',
      retiredClient: 0,
      retiredProject: 'proj-2',
      accepted: [true, true],
    },
    {
      responseProject: 'proj-2',
      retiredClient: 0,
      retiredProject: 'proj-2',
      accepted: [false, true],
    },
    {
      responseProject: 'proj-1',
      retiredClient: 1,
      retiredProject: 'proj-1',
      accepted: [true, false],
    },
  ])(
    'scopes response $responseProject to client $retiredClient and retired $retiredProject',
    async ({ responseProject, retiredClient, retiredProject, accepted }) => {
      const fixtures = [fixture(), fixture()];
      const owners = fixtures.map((f, index) => {
        const other = getProjectWorkspaceCacheReconciler(f.client, 'proj-2');
        const token = other.beginConnection();
        other.apply(token, {
          type: 'snapshot_full',
          projectId: 'proj-2',
          entries: [entry({ projectId: 'proj-2', name: `Stream ${index} proj-2` })],
        });
        f.full([entry({ projectId: 'proj-1', name: `Stream ${index} proj-1` })]);
        f.client.setQueryData(
          f.options.queryKey,
          detail({
            projectId: responseProject,
            name: `Cached ${index}`,
            worktreePath: `/cached/${index}`,
          })
        );
        return { 'proj-1': { owner: f.owner, token: f.token }, 'proj-2': { owner: other, token } };
      });
      const pending = fixtures.map((f) => f.client.fetchQuery({ ...f.options, staleTime: 0 }));
      const retired = owners[retiredClient]![retiredProject as 'proj-1' | 'proj-2'];
      retired.owner.retireConnection(retired.token);
      retired.owner.beginConnection();
      fixtures.forEach((f, index) =>
        f.resolve(
          detail({
            projectId: responseProject,
            name: `HTTP ${index}`,
            worktreePath: `/http/${index}`,
          })
        )
      );
      await Promise.all(pending);
      fixtures.forEach((f, index) =>
        expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
          projectId: responseProject,
          name: accepted[index] ? `Stream ${index} ${responseProject}` : `Cached ${index}`,
          worktreePath: accepted[index] ? `/http/${index}` : `/cached/${index}`,
        })
      );
    }
  );

  it('rejects fallback HTTP begun after retirement when the next connection has newer metadata', async () => {
    const f = fixture();
    f.owner.retireConnection(f.token);
    f.client.setQueryData(f.options.queryKey, detail({ worktreePath: '/current/detail' }));
    const pending = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(detail({ worktreePath: '/retired/fallback' }));
    await Promise.resolve();
    const next = f.owner.beginConnection();
    f.owner.apply(next, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'New connection' })],
    });
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      worktreePath: '/current/detail',
    });
  });

  it('releases a removed detail owner and isolates the replacement query from its old request', async () => {
    const f = fixture();
    const pending = f.client.fetchQuery(f.options).catch(() => undefined);
    f.client.removeQueries({ queryKey: f.options.queryKey, exact: true });
    const replacement = workspaceDetailQueryOptions(f.client, 'ws-1', () =>
      Promise.resolve(detail({ name: 'Replacement detail' }))
    );
    await f.client.fetchQuery(replacement);
    f.resolve(detail({ name: 'Removed request' }));
    await pending;
    await Promise.resolve();
    expect(f.client.getQueryData(replacement.queryKey)).toMatchObject({
      name: 'Replacement detail',
    });
  });

  it('retries an active initial detail if the project changes in the HTTP-resolution commit gap', async () => {
    const f = fixture();
    f.owner.retireConnection(f.token);
    const requests: Array<(data: WorkspaceDetail) => void> = [];
    const options = workspaceDetailQueryOptions(
      f.client,
      'gap',
      () => new Promise<WorkspaceDetail>((resolve) => requests.push(resolve))
    );
    const observer = new QueryObserver(f.client, options);
    const results: Array<{ status: string; data: WorkspaceDetail | undefined }> = [];
    const stop = observer.subscribe((result) =>
      results.push({ status: result.status, data: result.data })
    );
    try {
      requests[0]!(detail({ id: 'gap', worktreePath: '/old/gap' }));
      await Promise.resolve();
      f.owner.beginConnection();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
      expect(observer.getCurrentResult()).toMatchObject({ status: 'pending', isLoading: true });
      expect(results.some((result) => result.status === 'success')).toBe(false);
      requests[1]!(detail({ id: 'gap', worktreePath: '/current/gap' }));
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.worktreePath).toBe('/current/gap')
      );
      expect(
        results.every((result) => result.status !== 'success' || result.data !== undefined)
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it.each([
    { action: 'disable', cached: false },
    { action: 'disable', cached: true },
    { action: 'unmount', cached: false },
    { action: 'unmount', cached: true },
  ])(
    'settles a rejected commit when the observer becomes $action with cached=$cached',
    async ({ action, cached }) => {
      vi.useFakeTimers();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      clients.push(client);
      let stop: () => void = () => undefined;
      try {
        const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
        const connection = owner.beginConnection();
        const requests: Array<(data: WorkspaceDetail) => void> = [];
        const initial = workspaceDetailQueryOptions(
          client,
          'inactive',
          () => new Promise<WorkspaceDetail>((resolve) => requests.push(resolve))
        );
        const share = workspaceDetailCacheOptions(client, 'inactive').structuralSharing;
        let deactivate: () => void = () => undefined;
        const options = {
          ...initial,
          staleTime: 0,
          structuralSharing: (previous: unknown, next: unknown) => {
            try {
              return share(previous, next);
            } catch (error) {
              deactivate();
              throw error;
            }
          },
        };
        if (cached) {
          client.setQueryData(
            initial.queryKey,
            detail({ id: 'inactive', name: 'Cached before rejection' })
          );
        }
        const observer = new QueryObserver(client, options);
        stop = observer.subscribe(() => undefined);
        deactivate =
          action === 'disable' ? () => observer.setOptions({ ...options, enabled: false }) : stop;
        const query = client.getQueryCache().find({ queryKey: initial.queryKey })!;
        owner.retireConnection(connection);
        owner.beginConnection();
        requests[0]!(detail({ id: 'inactive', worktreePath: '/rejected/inactive' }));
        await vi.waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
        expect(requests).toHaveLength(1);
        expect(query.state.data).toBeUndefined();
        stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.getQueryCache().find({ queryKey: initial.queryKey })).toBeUndefined();
      } finally {
        stop();
        client.clear();
        vi.useRealTimers();
      }
    }
  );

  it.each(['fresh-write', 'replacement-query'] as const)(
    'protects a %s installed before deferred recovery',
    async (action) => {
      const f = fixture();
      const requests: Array<(data: WorkspaceDetail) => void> = [];
      const initial = workspaceDetailQueryOptions(
        f.client,
        'recovery-race',
        () => new Promise<WorkspaceDetail>((resolve) => requests.push(resolve))
      );
      const share = workspaceDetailCacheOptions(f.client, 'recovery-race').structuralSharing;
      const key = initial.queryKey;
      let replacement: Promise<WorkspaceDetail> | undefined;
      const observer = new QueryObserver(f.client, {
        ...initial,
        structuralSharing: (previous: unknown, next: unknown) => {
          try {
            return share(previous, next);
          } catch (error) {
            if (action === 'replacement-query') {
              f.client.removeQueries({ queryKey: key, exact: true });
              replacement = f.client.fetchQuery(
                workspaceDetailQueryOptions(f.client, 'recovery-race', () =>
                  Promise.resolve(
                    detail({ id: 'recovery-race', worktreePath: '/replacement/query' })
                  )
                )
              );
            } else {
              f.client.setQueryData(
                key,
                detail({ id: 'recovery-race', worktreePath: '/synchronous/write' })
              );
            }
            throw error;
          }
        },
      });
      const stop = observer.subscribe(() => undefined);
      try {
        f.owner.retireConnection(f.token);
        f.owner.beginConnection();
        requests[0]!(detail({ id: 'recovery-race', worktreePath: '/retired/response' }));
        if (action === 'fresh-write') {
          await vi.waitFor(() => expect(requests).toHaveLength(2));
          expect(f.client.getQueryData(key)).toMatchObject({ worktreePath: '/synchronous/write' });
          requests[1]!(detail({ id: 'recovery-race', worktreePath: '/fresh/retry' }));
          await vi.waitFor(() =>
            expect(f.client.getQueryData(key)).toMatchObject({ worktreePath: '/fresh/retry' })
          );
        } else {
          await vi.waitFor(() => expect(replacement).toBeDefined());
          await replacement;
          expect(requests).toHaveLength(1);
          expect(f.client.getQueryData(key)).toMatchObject({ worktreePath: '/replacement/query' });
        }
      } finally {
        stop();
      }
    }
  );

  it('preserves a new imperative fetch started by reset notifications on the same unobserved query', async () => {
    const f = fixture();
    const requests: Array<{ resolve: (data: WorkspaceDetail) => void; signal: AbortSignal }> = [];
    const fetchDetail = (signal: AbortSignal) =>
      new Promise<WorkspaceDetail>((resolve) => requests.push({ resolve, signal }));
    const initial = workspaceDetailQueryOptions(f.client, 'imperative', fetchDetail);
    const share = workspaceDetailCacheOptions(f.client, 'imperative').structuralSharing;
    let stop: () => void = () => undefined;
    const observer = new QueryObserver(f.client, {
      ...initial,
      structuralSharing: (previous: unknown, next: unknown) => {
        try {
          return share(previous, next);
        } catch (error) {
          stop();
          throw error;
        }
      },
    });
    stop = observer.subscribe(() => undefined);
    const query = f.client.getQueryCache().find({ queryKey: initial.queryKey })!;
    let recovery: Promise<WorkspaceDetail> | undefined;
    const unsubscribe = f.client.getQueryCache().subscribe((event) => {
      if (
        event.query === query &&
        event.type === 'updated' &&
        query.state.fetchStatus === 'idle' &&
        query.state.data === undefined &&
        !recovery
      ) {
        recovery = f.client.fetchQuery(
          workspaceDetailQueryOptions(f.client, 'imperative', fetchDetail)
        );
        void recovery.catch(() => undefined);
      }
    });
    try {
      f.owner.retireConnection(f.token);
      f.owner.beginConnection();
      requests[0]!.resolve(detail({ id: 'imperative', worktreePath: '/retired' }));
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]!.signal.aborted).toBe(false);
      expect(f.client.getQueryCache().find({ queryKey: initial.queryKey })).toBe(query);
      requests[1]!.resolve(detail({ id: 'imperative', worktreePath: '/fresh/imperative' }));
      await recovery;
      expect(f.client.getQueryData(initial.queryKey)).toMatchObject({
        worktreePath: '/fresh/imperative',
      });
    } finally {
      unsubscribe();
      stop();
    }
  });

  it.each(['removal', 'garbage collection'] as const)(
    'reuses the same detail query options after %s',
    async (departure) => {
      vi.useFakeTimers();
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: departure === 'removal' ? Infinity : 0 },
        },
      });
      clients.push(client);
      try {
        const responses = [
          detail({ name: 'First fetch', worktreePath: '/first' }),
          detail({ name: 'Second fetch', worktreePath: '/second' }),
        ];
        let calls = 0;
        const options = workspaceDetailQueryOptions(client, 'ws-1', () =>
          Promise.resolve(responses[calls++]!)
        );
        await client.fetchQuery(options);
        if (departure === 'removal') {
          client.removeQueries({ queryKey: options.queryKey, exact: true });
        } else {
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(client.getQueryCache().find({ queryKey: options.queryKey })).toBeUndefined();
        await client.fetchQuery(options);
        expect(calls).toBe(2);
        expect(client.getQueryData(options.queryKey)).toMatchObject({
          name: 'Second fetch',
          worktreePath: '/second',
        });
        client.setQueryData(
          options.queryKey,
          detail({ name: 'Manual cache write', worktreePath: '/manual' })
        );
        expect(client.getQueryData(options.queryKey)).toMatchObject({
          name: 'Manual cache write',
          worktreePath: '/manual',
        });
      } finally {
        client.clear();
        vi.useRealTimers();
      }
    }
  );

  it('keeps late old HTTP provenance separate from a replacement using the same options', async () => {
    const f = fixture();
    const requests: Array<(data: WorkspaceDetail) => void> = [];
    const base = workspaceDetailQueryOptions(
      f.client,
      'ws-1',
      () => new Promise<WorkspaceDetail>((resolve) => requests.push(resolve))
    );
    const fetch = base.queryFn;
    if (typeof fetch !== 'function') {
      throw new Error('Expected a detail query function');
    }
    let call = 0;
    let oldResult: WorkspaceDetail | undefined;
    const options = {
      ...base,
      queryFn: async (context: Parameters<typeof fetch>[0]) => {
        const currentCall = call++;
        const data = await fetch(context);
        if (currentCall === 0) {
          oldResult = data;
        }
        return data;
      },
    };
    const old = f.client.fetchQuery(options).catch(() => undefined);
    f.client.removeQueries({ queryKey: options.queryKey, exact: true });
    const current = f.client.fetchQuery(options);
    const replacement = detail({ name: 'Replacement HTTP', worktreePath: '/replacement' });
    requests[1]!(replacement);
    await current;
    const stale = detail({ name: 'Cancelled old HTTP', worktreePath: '/old' });
    requests[0]!(stale);
    await old;
    await vi.waitFor(() => expect(oldResult).toBeDefined());
    const before = f.client.getQueryData(options.queryKey);
    expect(before).toMatchObject({ name: 'Replacement HTTP', worktreePath: '/replacement' });
    // Its first attempted cache commit must retain HTTP provenance even though
    // the originating Query has already been removed.
    f.client.setQueryData(options.queryKey, oldResult);
    expect(f.client.getQueryData(options.queryKey)).toBe(before);
    f.client.setQueryData(options.queryKey, { ...replacement, name: 'Normal manual write' });
    expect(f.client.getQueryData(options.queryKey)).toMatchObject({ name: 'Normal manual write' });
  });

  it('keeps reused immutable HTTP objects distinct across old and replacement commit provenance', async () => {
    const f = fixture();
    f.full([entry({ name: 'Current stream' })]);
    const shared = Object.freeze(
      detail({ name: 'Shared HTTP name', worktreePath: '/http/shared' })
    );
    const requests: Array<(data: WorkspaceDetail) => void> = [];
    const base = workspaceDetailQueryOptions(
      f.client,
      'ws-1',
      () => new Promise<WorkspaceDetail>((resolve) => requests.push(resolve))
    );
    const fetch = base.queryFn;
    if (typeof fetch !== 'function') {
      throw new Error('Expected a detail query function');
    }
    let call = 0;
    let oldResult: WorkspaceDetail | undefined;
    let afterOldCommit: unknown;
    const options = {
      ...base,
      staleTime: 0,
      queryFn: async (context: Parameters<typeof fetch>[0]) => {
        const currentCall = call++;
        const data = await fetch(context);
        if (currentCall === 0) {
          oldResult = data;
        } else {
          // Old completion runs after replacement tagging but before its success
          // continuation, with the exact same immutable fetcher response object.
          f.client.setQueryData(base.queryKey, oldResult);
          afterOldCommit = f.client.getQueryData(base.queryKey);
        }
        return data;
      },
    };
    const old = f.client.fetchQuery(options).catch(() => undefined);
    f.client.removeQueries({ queryKey: options.queryKey, exact: true });
    requests[0]!(shared);
    await vi.waitFor(() => expect(oldResult).toBeDefined());
    f.client.setQueryData(
      options.queryKey,
      detail({ name: 'Cached current', worktreePath: '/cached/current' })
    );
    const current = f.client.fetchQuery(options);
    requests[1]!(shared);
    const returned = await current;
    await old;
    expect(afterOldCommit).toMatchObject({
      name: 'Cached current',
      worktreePath: '/cached/current',
    });
    expect(f.client.getQueryData(options.queryKey)).toMatchObject({
      name: 'Current stream',
      worktreePath: '/http/shared',
    });
    expect(returned.createdAt).toBe(shared.createdAt);
    expect(returned.agentSessions).toBe(shared.agentSessions);
    expect(returned.terminalSessions).toBe(shared.terminalSessions);
    // The replacement's consumed HTTP identity remains a deliberate manual
    // write when explicitly reused after its automatic success commit.
    f.client.setQueryData(options.queryKey, returned);
    expect(f.client.getQueryData(options.queryKey)).toMatchObject({ name: 'Shared HTTP name' });
  });

  it('releases cached owners when an inactive detail query is garbage-collected', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    clients.push(client);
    try {
      const first = workspaceDetailQueryOptions(client, 'collected', () =>
        Promise.resolve(detail({ id: 'collected' }))
      );
      await client.fetchQuery(first);
      expect(client.getQueryCache().find({ queryKey: first.queryKey })).toBeDefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getQueryCache().find({ queryKey: first.queryKey })).toBeUndefined();
      const replacement = workspaceDetailQueryOptions(client, 'collected', () =>
        Promise.resolve(detail({ id: 'collected', name: 'After collection' }))
      );
      await client.fetchQuery(replacement);
      expect(client.getQueryData(replacement.queryKey)).toMatchObject({ name: 'After collection' });
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });

  it('accepts deliberately opened archived detail outside live membership', async () => {
    const f = fixture();
    f.full([]);
    const pending = f.client.fetchQuery(f.options);
    f.resolve(detail({ status: 'ARCHIVED', name: 'Archived HTTP' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      status: 'ARCHIVED',
      name: 'Archived HTTP',
    });
    expect(f.client.getQueryData(f.owner.queryKey)).toMatchObject({ workspaces: [] });
  });

  it('consumes HTTP identity once so explicit reuse and optimistic writes keep their semantics', async () => {
    const f = fixture();
    f.full([entry({ name: 'Stream' })]);
    const pending = f.client.fetchQuery(f.options);
    const response = detail({ name: 'HTTP' });
    f.resolve(response);
    const returned = await pending;
    expect(returned).toEqual(response);
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Stream' });
    f.client.setQueryData(f.options.queryKey, returned);
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'HTTP' });
    f.client.setQueryData(f.options.queryKey, { ...returned, name: 'Optimistic' });
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Optimistic' });
  });

  it('preserves unchanged live references and Date identity during HTTP metadata repair', async () => {
    const f = fixture();
    const updatedAt = new Date('2026-01-03');
    const baseline = entry({ prUpdatedAt: updatedAt.toISOString() });
    const row = detail({ createdAt: new Date(baseline.createdAt), prUpdatedAt: updatedAt });
    f.client.setQueryData(f.options.queryKey, row);
    f.full([baseline]);
    const before = f.client.getQueryData<WorkspaceDetail>(f.options.queryKey)!;
    const pending = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve({
      ...row,
      name: 'Stale HTTP',
      prUpdatedAt: new Date('2025-01-01'),
      worktreePath: '/new/path',
    });
    await pending;
    const after = f.client.getQueryData<WorkspaceDetail>(f.options.queryKey)!;
    expect(after).not.toBe(before);
    expect(after.worktreePath).toBe('/new/path');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.prUpdatedAt).toBe(before.prUpdatedAt);
    expect(after.sessionSummaries).toBe(before.sessionSummaries);
    expect(after.prMonitoring).toBe(before.prMonitoring);
    const repair = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve({ ...after, name: 'Stale HTTP' });
    await repair;
    expect(f.client.getQueryData(f.options.queryKey)).toBe(after);
  });
});
