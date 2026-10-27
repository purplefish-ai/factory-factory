import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

const clients: QueryClient[] = [];
const list = (name = 'http', id = 'ws-1') => ({
  workspaces: [
    { ...projectSnapshotToWorkspace(entry({ workspaceId: id, name })), githubIssueNumber: 42 },
  ],
  reviewCount: 99,
});
function fixture(projectId = 'proj-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const owner = getProjectWorkspaceCacheReconciler(client, projectId);
  const token = owner.beginConnection();
  let resolve!: (value: ReturnType<typeof list>) => void;
  const options = projectWorkspaceQueryOptions(
    client,
    projectId,
    () =>
      new Promise<ReturnType<typeof list>>((done) => {
        resolve = done;
      })
  );
  return {
    client,
    owner,
    token,
    options,
    resolve: (value: ReturnType<typeof list>) => resolve(value),
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

describe('project workspace HTTP/stream commit ownership', () => {
  it('preserves cache and nested references across unchanged full snapshots and equal HTTP repair', async () => {
    const f = fixture();
    const bootstrap = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list('baseline'));
    await bootstrap;
    const full = {
      type: 'snapshot_full' as const,
      projectId: 'proj-1',
      entries: [entry({ name: 'baseline' })],
      reviewCount: 3,
    };
    f.owner.apply(f.token, full);
    const before = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    f.owner.apply(f.token, structuredClone(full));
    expect(f.client.getQueryData(f.options.queryKey)).toBe(before);
    const repair = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list('stale HTTP name'));
    await repair;
    const after = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    expect(after).toBe(before);
    expect(after.workspaces).toBe(before.workspaces);
    expect(after.workspaces[0]?.prMonitoring).toBe(before.workspaces[0]?.prMonitoring);
    expect(after.workspaces[0]?.createdAt).toBe(before.workspaces[0]?.createdAt);
  });

  it('replaces only changed nested snapshot references and retains other rows', async () => {
    const f = fixture();
    const bootstrap = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list());
    await bootstrap;
    const first = entry({ name: 'first' });
    const second = entry({ workspaceId: 'ws-2', name: 'second' });
    f.owner.apply(f.token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [first, second],
    });
    const before = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    const changed = structuredClone(first);
    changed.prMonitoring = { ...changed.prMonitoring, bindingRevision: 1 };
    f.owner.apply(f.token, { type: 'snapshot_changed', workspaceId: 'ws-1', entry: changed });
    const after = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    expect(after).not.toBe(before);
    expect(after.workspaces).not.toBe(before.workspaces);
    expect(after.workspaces[0]).not.toBe(before.workspaces[0]);
    expect(after.workspaces[0]?.prMonitoring).not.toBe(before.workspaces[0]?.prMonitoring);
    expect(after.workspaces[0]?.prMonitoring.bindingRevision).toBe(1);
    expect(after.workspaces[0]?.sessionSummaries).toBe(before.workspaces[0]?.sessionSummaries);
    expect(after.workspaces[0]?.createdAt).toBe(before.workspaces[0]?.createdAt);
    expect(after.workspaces[1]).toBe(before.workspaces[1]);
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: { ...changed, createdAt: '2026-02-01T00:00:00Z' },
    });
    const redated = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    expect(redated.workspaces[0]?.createdAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(redated.workspaces[0]?.createdAt).not.toBe(after.workspaces[0]?.createdAt);
    expect(redated.workspaces[1]).toBe(after.workspaces[1]);
  });

  it('preserves default sharing for bootstrap HTTP and explicit optimistic writes', async () => {
    const f = fixture();
    const bootstrap = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list());
    await bootstrap;
    const before = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    const equal = {
      ...before,
      workspaces: before.workspaces.map((row) => ({
        ...row,
        prMonitoring: { ...row.prMonitoring },
      })),
    };
    const second = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(equal);
    await second;
    expect(f.client.getQueryData(f.options.queryKey)).toBe(before);
    f.client.setQueryData(f.options.queryKey, {
      ...equal,
      workspaces: equal.workspaces.map((row) => ({ ...row, name: 'optimistic name' })),
    });
    const optimistic = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    expect(optimistic.workspaces[0]?.name).toBe('optimistic name');
    expect(optimistic.workspaces[0]?.prMonitoring).toBe(before.workspaces[0]?.prMonitoring);
    expect(optimistic.workspaces[0]?.createdAt).toBe(before.workspaces[0]?.createdAt);
  });

  it('allows HTTP membership and live fields before a current full baseline', async () => {
    const f = fixture();
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list());
    await fetch;
    expect(f.client.getQueryData(f.options.queryKey)).toEqual(list());
  });

  it('reconciles late bootstrap at commit while hydrating omitted metadata', async () => {
    const f = fixture();
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.owner.apply(f.token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'stream' })],
      reviewCount: 2,
    });
    f.resolve(list());
    await fetch;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      workspaces: [{ name: 'stream', githubIssueNumber: 42 }],
      reviewCount: 2,
    });
  });

  it.each(['snapshot_changed', 'snapshot_removed', 'empty'] as const)(
    'protects %s after HTTP has resolved but before the cache commits',
    async (kind) => {
      const f = fixture();
      f.owner.apply(f.token, {
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [entry({ name: 'baseline' })],
        reviewCount: 3,
      });
      const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
      f.resolve(list());
      // queryFn's await has resumed, but Query's success continuation has not committed.
      await Promise.resolve();
      if (kind === 'empty') {
        f.owner.apply(f.token, {
          type: 'snapshot_full',
          projectId: 'proj-1',
          entries: [],
          reviewCount: 0,
        });
      } else if (kind === 'snapshot_removed') {
        f.owner.apply(f.token, { type: kind, workspaceId: 'ws-1', reviewCount: 0 });
      } else {
        f.owner.apply(f.token, {
          type: kind,
          workspaceId: 'ws-1',
          entry: entry({ name: 'newest' }),
          reviewCount: 4,
        });
      }
      await fetch;
      const value = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
      expect(value.workspaces.map((row) => row.name)).toEqual(
        kind === 'snapshot_changed' ? ['newest'] : []
      );
      expect(value.reviewCount).toBe(kind === 'snapshot_changed' ? 4 : 0);
    }
  );

  it('allows HTTP reviewCount when no stream message supplied it', async () => {
    const f = fixture();
    f.owner.apply(f.token, { type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list());
    await fetch;
    expect(f.client.getQueryData(f.options.queryKey)).toEqual({ workspaces: [], reviewCount: 99 });
  });

  it('does not classify explicit optimistic writes as HTTP', async () => {
    const f = fixture();
    f.owner.apply(f.token, { type: 'snapshot_full', projectId: 'proj-1', entries: [entry()] });
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list());
    await fetch;
    const previous = f.client.getQueryData<ReturnType<typeof list>>(f.options.queryKey)!;
    f.client.setQueryData(f.options.queryKey, { ...previous, workspaces: [] });
    expect(f.client.getQueryData(f.options.queryKey)).toEqual({ ...previous, workspaces: [] });
    f.client.setQueryData(f.options.queryKey, previous);
    expect(f.client.getQueryData(f.options.queryKey)).toEqual(previous);
  });

  it('consumes the HTTP identity tag even when the exact response object is reused explicitly', async () => {
    const f = fixture();
    f.owner.apply(f.token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'stream' })],
    });
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    const response = list('http');
    f.resolve(response);
    const returned = await fetch;
    expect(returned).toBe(response);
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      workspaces: [{ name: 'stream' }],
    });
    // A deliberate manual write is not a second HTTP commit of this object.
    f.client.setQueryData(f.options.queryKey, returned);
    const manual = f.client.getQueryData(f.options.queryKey);
    expect(manual).toEqual(returned);
    const cached = await f.client.fetchQuery(f.options);
    expect(cached).toBe(manual);
  });

  it('does not resurrect an optimistic archive during metadata repair', async () => {
    const f = fixture();
    f.owner.apply(f.token, { type: 'snapshot_full', projectId: 'proj-1', entries: [entry()] });
    f.client.setQueryData(f.options.queryKey, { workspaces: [], reviewCount: 0 });
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(list());
    await fetch;
    expect(f.client.getQueryData(f.options.queryKey)).toEqual({ workspaces: [], reviewCount: 99 });
  });

  it('retires old callbacks and accepts lower versions on a new connection', () => {
    const f = fixture();
    f.owner.apply(f.token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'old', version: 100 })],
    });
    expect(f.owner.retireConnection(f.token)).toBe(true);
    expect(f.owner.retireConnection(f.token)).toBe(false);
    const next = f.owner.beginConnection();
    expect(
      f.owner.apply(f.token, { type: 'snapshot_full', projectId: 'proj-1', entries: [] })
    ).toBe(false);
    f.owner.apply(next, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'new', version: 1 })],
    });
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      workspaces: [{ name: 'new' }],
    });
  });

  it('does not commit HTTP from a retired connection into current HTTP mode', async () => {
    const f = fixture();
    f.client.setQueryData(f.options.queryKey, list('existing'));
    const fetch = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.owner.retireConnection(f.token);
    f.owner.beginConnection();
    f.resolve(list('retired'));
    await fetch;
    expect(f.client.getQueryData(f.options.queryKey)).toEqual(list('existing'));
  });

  it('scopes ownership to QueryClient and project, including A→B→A', () => {
    const a = fixture();
    const b = getProjectWorkspaceCacheReconciler(a.client, 'proj-2');
    const bt = b.beginConnection();
    a.owner.apply(a.token, { type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    a.owner.retireConnection(a.token);
    b.apply(bt, { type: 'snapshot_full', projectId: 'proj-2', entries: [] });
    b.retireConnection(bt);
    const nextA = a.owner.beginConnection();
    expect(a.owner.apply(a.token, { type: 'snapshot_removed', workspaceId: 'ws-1' })).toBe(false);
    expect(a.owner.apply(nextA, { type: 'snapshot_full', projectId: 'proj-2', entries: [] })).toBe(
      false
    );
    expect(
      a.owner.apply(nextA, { type: 'snapshot_full', projectId: 'proj-1', entries: [entry()] })
    ).toBe(true);
    const separate = fixture();
    expect(separate.owner).not.toBe(a.owner);
    expect(getProjectWorkspaceCacheReconciler(a.client, 'proj-1')).toBe(a.owner);
  });
});
