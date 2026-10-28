import { CancelledError, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { beginWorkspaceArchiveOperation } from '@/client/lib/workspace-archive-operation';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
  type ProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-reconciler';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

const clients: QueryClient[] = [];
const data = (name = 'HTTP') => ({
  workspaces: [
    projectSnapshotToWorkspace(entry({ name })),
    projectSnapshotToWorkspace(entry({ workspaceId: 'ws-2' })),
  ],
  reviewCount: 0,
});
function fixture(seed = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
  const requests: ((data: ProjectWorkspaceCache) => void)[] = [];
  const options = projectWorkspaceQueryOptions(
    client,
    'proj-1',
    () => new Promise<ProjectWorkspaceCache>((resolve) => requests.push(resolve))
  );
  if (seed) {
    client.setQueryData(options.queryKey, data());
  }
  return {
    client,
    owner,
    options,
    requests,
    rows: () => client.getQueryData<ProjectWorkspaceCache>(options.queryKey)?.workspaces,
  };
}
afterEach(() => clients.splice(0).forEach((client) => client.clear()));

describe('archive settlement HTTP provenance without a stream baseline', () => {
  it.each(['before', 'during'])(
    'rejects stale HTTP started %s archive success, while fresh post-settlement HTTP can introduce rows',
    async (timing) => {
      const f = fixture();
      const operation =
        timing === 'during'
          ? beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1'])
          : undefined;
      const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
      const active = operation ?? beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
      active.settle([]);
      f.requests[0]!(data('stale archived row'));
      await fetch;
      expect(f.rows()?.map((row) => row.id)).toEqual(['ws-2']);
      const fresh = f.client.fetchQuery({ ...f.options, staleTime: 0 });
      f.requests[1]!({
        ...data('legitimate later introduction'),
        workspaces: [
          ...data('legitimate later introduction').workspaces,
          projectSnapshotToWorkspace(entry({ workspaceId: 'newcomer' })),
        ],
      });
      const result = await fresh;
      expect(f.rows()?.[0]?.name).toBe('legitimate later introduction');
      expect(f.rows()?.map((row) => row.id)).toContain('newcomer');
      // A consumed HTTP result remains an ordinary explicit write.
      f.client.setQueryData(f.options.queryKey, { workspaces: [], reviewCount: 0 });
      f.client.setQueryData(f.options.queryKey, result);
      expect(f.rows()?.[0]?.name).toBe('legitimate later introduction');
    }
  );

  it('checks settlement freshness at actual commit, after the HTTP query function has resolved', async () => {
    const f = fixture();
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const fetch = f.client.fetchQuery({
      ...f.options,
      staleTime: 0,
      queryFn: async (context) => {
        const result = await f.options.queryFn!(context);
        operation.settle([]);
        return result;
      },
    });
    f.requests[0]!(data('resolved before settlement'));
    await fetch;
    expect(f.rows()?.map((row) => row.id)).toEqual(['ws-2']);
  });

  it('recovers a mounted empty bootstrap instead of succeeding with undefined or remaining stuck', async () => {
    const f = fixture(false);
    const observer = new QueryObserver(f.client, f.options);
    const successes: (ProjectWorkspaceCache | undefined)[] = [];
    const unsubscribe = observer.subscribe((result) => {
      if (result.status === 'success') {
        successes.push(result.data);
      }
    });
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
      operation.settle([]);
      f.requests[0]!(data('stale bootstrap'));
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!({ workspaces: [data().workspaces[1]!], reviewCount: 0 });
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      expect(successes).not.toContain(undefined);
      expect(
        successes.every((result) => result?.workspaces.every((row) => row.id !== 'ws-1'))
      ).toBe(true);
      expect(f.rows()?.map((row) => row.id)).toEqual(['ws-2']);
      expect(observer.getCurrentResult().fetchStatus).toBe('idle');
    } finally {
      unsubscribe();
    }
  });

  it('fences a request made after overlap success but before the final failed release', async () => {
    const f = fixture();
    const first = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const second = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    first.settle([]);
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    second.settle(['ws-1']);
    f.requests[0]!(data('stale overlap row'));
    await fetch;
    expect(f.rows()?.map((row) => row.id)).toEqual(['ws-2']);
  });

  it.each([false, true])(
    'keeps newer bootstrap/repair fetching while an old commit unwinds (cached=%s)',
    async (present) => {
      const f = fixture(present);
      const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
      let resolveOld!: (value: ProjectWorkspaceCache) => void;
      const old = new Promise<ProjectWorkspaceCache>((resolve) => {
        resolveOld = resolve;
      });
      let calls = 0;
      const observer = new QueryObserver(f.client, {
        ...f.options,
        staleTime: 0,
        queryFn: () => {
          if (++calls !== 1) {
            return f.owner.fetch(
              () => new Promise<ProjectWorkspaceCache>((resolve) => f.requests.push(resolve)),
              new AbortController().signal
            );
          }
          const tagged = f.owner.fetch(() => old, new AbortController().signal);
          // Register before returning to retryer: settlement then runs after retryer
          // resolution but before Query.fetch's old cache-commit continuation.
          void tagged.then(() =>
            queueMicrotask(() => {
              operation.settle([]);
              void f.client.invalidateQueries({ queryKey: f.options.queryKey, exact: true });
            })
          );
          return tagged;
        },
      });
      const unsubscribe = observer.subscribe(() => undefined);
      try {
        resolveOld(data('old continuation'));
        await vi.waitFor(() => expect(calls).toBe(2));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(f.rows()?.map((row) => row.id) ?? []).not.toContain('ws-1');
        expect(observer.getCurrentResult().fetchStatus).toBe('fetching');
        f.requests[0]!({
          workspaces: [projectSnapshotToWorkspace(entry({ workspaceId: 'newcomer' }))],
          reviewCount: 0,
        });
        await vi.waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe('idle'));
        expect(f.rows()?.map((row) => row.id)).toEqual(['newcomer']);
        expect(observer.getCurrentResult().isSuccess).toBe(true);
      } finally {
        unsubscribe();
      }
    }
  );

  it('keeps concurrent attempt provenance distinct when a fetcher reuses one immutable response', async () => {
    const f = fixture();
    const shared = Object.freeze(data('shared response'));
    const requests: ((value: ProjectWorkspaceCache) => void)[] = [];
    const base = projectWorkspaceQueryOptions(
      f.client,
      'proj-1',
      () => new Promise<ProjectWorkspaceCache>((resolve) => requests.push(resolve))
    );
    const fetch = base.queryFn;
    if (typeof fetch !== 'function') {
      throw new Error('Expected a list query function');
    }
    let calls = 0;
    let oldResult: ProjectWorkspaceCache | undefined;
    let afterOldCommit: ProjectWorkspaceCache | undefined;
    const options = {
      ...base,
      staleTime: 0,
      queryFn: async (context: Parameters<typeof fetch>[0]) => {
        const call = calls++;
        const result = await fetch(context);
        if (call === 0) {
          oldResult = result;
        } else {
          expect(() => f.client.setQueryData(base.queryKey, oldResult)).toThrow(CancelledError);
          afterOldCommit = f.client.getQueryData(base.queryKey);
        }
        return result;
      },
    };
    const old = f.client.fetchQuery(options).catch(() => undefined);
    f.client.removeQueries({ queryKey: base.queryKey, exact: true });
    requests[0]!(shared);
    await vi.waitFor(() => expect(oldResult).toBeDefined());
    f.client.setQueryData(base.queryKey, data());
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    operation.settle([]);
    const fresh = f.client.fetchQuery(options);
    requests[1]!(shared);
    const result = await fresh;
    await old;
    expect(afterOldCommit?.workspaces.map((row) => row.id)).toEqual(['ws-2']);
    expect(f.rows()?.map((row) => row.id)).toEqual(['ws-1', 'ws-2']);
    expect(result.workspaces).toBe(shared.workspaces);
    expect(result.workspaces[0]?.createdAt).toBe(shared.workspaces[0]?.createdAt);
    f.client.setQueryData(base.queryKey, { workspaces: [], reviewCount: 0 });
    f.client.setQueryData(base.queryKey, result);
    expect(f.rows()?.map((row) => row.id)).toEqual(['ws-1', 'ws-2']);
  });

  it('preserves failed-only rollback and accepts its fresh post-settlement repair', async () => {
    const f = fixture();
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    operation.settle(['ws-1']);
    f.requests[0]!(data('superseded failure repair'));
    await fetch;
    expect(f.rows()?.[0]?.name).toBe('HTTP');
    const fresh = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.requests[1]!(data('eligible failure repair'));
    await fresh;
    expect(f.rows()?.[0]?.name).toBe('eligible failure repair');
  });
});
