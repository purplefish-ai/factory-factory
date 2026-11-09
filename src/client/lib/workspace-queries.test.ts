import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import { getProjectWorkspaceCacheReconciler } from '@/client/lib/workspace-cache-reconciler';
import {
  ensureWorkspaceDetail,
  fetchWorkspaceDetail,
  mergeWorkspaceDetailSnapshot,
  projectWorkspaceListQuery,
  seedWorkspaceDetail,
  setProjectWorkspaceList,
  workspaceDetailQuery,
} from '@/client/lib/workspace-queries';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

const row = (name: string) => projectSnapshotToWorkspace(entry({ name }));
const detail = (name: string) =>
  unsafeCoerce<WorkspaceDetail>({ ...row(name), description: 'HTTP-only detail' });

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

/** A real tRPC client whose transport answers every request with the current HTTP state. */
function fixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  cleanup.push(() => queryClient.clear());
  const http = { name: 'HTTP name', paths: [] as string[] };
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            http.paths.push(op.path);
            const data =
              op.path === 'workspace.get'
                ? detail(http.name)
                : { workspaces: [row(http.name)], reviewCount: 0 };
            observer.next({ result: { data } });
            observer.complete();
          }),
    ],
  });
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
  const connection = owner.beginConnection();
  const goLive = (name: string) =>
    owner.apply(connection, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name })],
    });
  const observeList = () => {
    const observer = new QueryObserver(
      queryClient,
      projectWorkspaceListQuery(queryClient, client, 'proj-1')
    );
    cleanup.push(observer.subscribe(() => undefined));
    return observer;
  };
  const settled = () => vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return { queryClient, client, http, goLive, observeList, settled };
}

describe('workspace query ownership', () => {
  it('reconciles an imperative detail fetch with the live stream', async () => {
    const f = fixture();
    f.goLive('Live name');
    const workspace = await fetchWorkspaceDetail(f.queryClient, f.client, 'ws-1');
    expect(workspace.projectId).toBe('proj-1');
    const cached = f.queryClient.getQueryData<WorkspaceDetail>(
      workspaceDetailQuery(f.queryClient, f.client, 'ws-1').queryKey
    );
    expect(cached?.name).toBe('Live name');
    expect(cached?.description).toBe('HTTP-only detail');
  });

  it('serves cached detail to ensure without another request', async () => {
    const f = fixture();
    await fetchWorkspaceDetail(f.queryClient, f.client, 'ws-1');
    f.http.name = 'Newer HTTP name';
    expect((await ensureWorkspaceDetail(f.queryClient, f.client, 'ws-1')).name).toBe('HTTP name');
    expect(f.http.paths).toEqual(['workspace.get']);
  });

  it('keeps the reconciler installed when a second list reader refetches the key', async () => {
    const f = fixture();
    const sidebar = f.observeList();
    await f.settled();
    f.goLive('Live name');
    // Another consumer (such as a creation form) reads the same key and refetches it.
    const form = f.observeList();
    await form.refetch();
    // Invalidation refetches with whichever options the key holds now.
    await f.queryClient.invalidateQueries({ queryKey: sidebar.options.queryKey });
    expect(sidebar.getCurrentResult().data?.workspaces.map(({ name }) => name)).toEqual([
      'Live name',
    ]);
    expect(f.http.paths).toEqual(Array(3).fill('workspace.listForProject'));
  });

  it('writes optimistic list rows and stream detail merges to the owned keys', async () => {
    const f = fixture();
    const list = f.observeList();
    await f.settled();
    setProjectWorkspaceList(f.queryClient, 'proj-1', (current) => ({
      workspaces: [row('Optimistic'), ...(current?.workspaces ?? [])],
      reviewCount: current?.reviewCount ?? 0,
    }));
    expect(list.getCurrentResult().data?.workspaces.map(({ name }) => name)).toEqual([
      'Optimistic',
      'HTTP name',
    ]);

    const key = workspaceDetailQuery(f.queryClient, f.client, 'ws-1').queryKey;
    mergeWorkspaceDetailSnapshot(f.queryClient, entry({ name: 'Before detail' }));
    expect(f.queryClient.getQueryData(key)).toBeUndefined();
    seedWorkspaceDetail(f.queryClient, 'ws-1', () => detail('Seed'));
    seedWorkspaceDetail(f.queryClient, 'ws-1', () => detail('Second seed'));
    expect(f.queryClient.getQueryData<WorkspaceDetail>(key)?.name).toBe('Seed');
    mergeWorkspaceDetailSnapshot(f.queryClient, entry({ name: 'Merged' }));
    expect(f.queryClient.getQueryData<WorkspaceDetail>(key)).toMatchObject({
      name: 'Merged',
      description: 'HTTP-only detail',
    });
  });
});
