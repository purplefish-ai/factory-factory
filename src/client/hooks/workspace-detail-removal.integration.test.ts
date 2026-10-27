import { type Server } from 'node:http';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import { initTRPC, TRPCError } from '@trpc/server';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { makeWorkspaceSnapshotEntry as makeEntry } from '@/test-utils/workspace-snapshot';
import { useProjectSnapshotSync } from './use-project-snapshot-sync';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useCallback: (fn: (...args: never[]) => unknown) => fn,
  useRef: <T>(value: T) => ({ current: value }),
}));

let channel: UseWebSocketTransportOptions;
vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (options: UseWebSocketTransportOptions) => {
    channel = options;
    return { connected: true, send: vi.fn(), reconnect: vi.fn() };
  },
}));
let utils: ReturnType<typeof createTRPCQueryUtils<FixtureRouter>>;
vi.mock('@/client/lib/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/client/lib/trpc')>();
  return { ...actual, trpc: { workspace: actual.trpc.workspace, useUtils: () => utils } };
});
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => queryClient,
}));

const t = initTRPC.create({ transformer: superjson });
const detail = (status: 'READY' | 'ARCHIVING' | 'ARCHIVED' = 'READY') =>
  projectSnapshotToWorkspace(makeEntry({ status }));
const requests: ReturnType<typeof Promise.withResolvers<ReturnType<typeof detail>>>[] = [];
const router = t.router({
  workspace: t.router({
    get: t.procedure.input(z.object({ id: z.string() })).query(async () => {
      const request = Promise.withResolvers<ReturnType<typeof detail>>();
      requests.push(request);
      return await request.promise;
    }),
    listForProject: t.procedure.input(z.object({ projectId: z.string() })).query(() => ({
      workspaces: [detail()],
      reviewCount: 0,
    })),
  }),
});
type FixtureRouter = typeof router;
const queryKey = [['workspace', 'get'], { input: { id: 'ws-1' }, type: 'query' }] as const;
let server: Server | undefined;
let queryClient: QueryClient;
const unsubscribes: Array<() => void> = [];

async function fixture(active = true) {
  requests.length = 0;
  server = createHTTPServer({ router });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server');
  }
  const client = createTRPCClient<FixtureRouter>({
    links: [httpLink({ url: `http://127.0.0.1:${address.port}`, transformer: superjson })],
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  utils = createTRPCQueryUtils({ client, queryClient });
  utils.workspace.listForProject.setData(
    { projectId: 'proj-1' },
    {
      workspaces: [{ ...detail(), worktreePath: '/existing/worktree' }],
      reviewCount: 0,
    }
  );
  utils.workspace.get.setData({ id: 'ws-1' }, detail());
  const signals: AbortSignal[] = [];
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: ({ signal }) => {
      signals.push(signal);
      return client.workspace.get.query({ id: 'ws-1' }, { signal });
    },
  });
  if (active) {
    unsubscribes.push(observer.subscribe(() => undefined));
  }
  return { observer, signals };
}

function remove(workspaceId = 'ws-1') {
  channel.onMessage!({ type: 'snapshot_removed', workspaceId });
}

async function waitForRequests(count: number) {
  await vi.waitFor(() => expect(requests).toHaveLength(count));
}

afterEach(async () => {
  for (const unsubscribe of unsubscribes.splice(0)) {
    unsubscribe();
  }
  queryClient?.clear();
  for (const request of requests) {
    request.resolve(detail('ARCHIVED'));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

describe('snapshot live-membership removal with real detail queries', () => {
  it('pins why setData(undefined) cannot clear an existing detail without initialData', async () => {
    const { observer } = await fixture();
    useProjectSnapshotSync('proj-1');
    expect(queryClient.getQueryCache().find({ queryKey })?.options.initialData).toBeUndefined();
    utils.workspace.get.setData({ id: 'ws-1' }, undefined);
    expect(observer.getCurrentResult().data?.status).toBe('READY');
  });

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'clears an active detail synchronously, then fetches persisted %s state',
    async (status) => {
      const { observer } = await fixture();
      useProjectSnapshotSync('proj-1');
      remove();
      expect(observer.getCurrentResult()).toMatchObject({ data: undefined, isPending: true });
      await waitForRequests(1);
      requests[0]!.resolve(detail(status));
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe(status));
    }
  );

  it('cancels an old HTTP request before refetch and ignores its late live result', async () => {
    const { observer, signals } = await fixture();
    useProjectSnapshotSync('proj-1');
    const previousFetch = observer.refetch();
    await waitForRequests(1);
    remove();
    expect(signals[0]?.aborted).toBe(true);
    expect(observer.getCurrentResult().data).toBeUndefined();
    await waitForRequests(2);
    requests[1]!.resolve(detail('ARCHIVED'));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED'));
    requests[0]!.resolve(detail());
    await previousFetch;
    expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED');
  });

  it('keeps stale live detail cleared if replacement fetch returns not found', async () => {
    const { observer } = await fixture();
    useProjectSnapshotSync('proj-1');
    remove();
    expect(observer.getCurrentResult().data).toBeUndefined();
    await waitForRequests(1);
    requests[0]!.reject(new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' }));
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(observer.getCurrentResult()).toMatchObject({
      data: undefined,
      error: { data: { code: 'NOT_FOUND' } },
    });
  });

  it('clears an inactive detail without fetching and fetches on later observation', async () => {
    const { observer } = await fixture(false);
    useProjectSnapshotSync('proj-1');
    remove();
    expect(utils.workspace.get.getData({ id: 'ws-1' })).toBeUndefined();
    expect(queryClient.getQueryState(queryKey)?.status).toBe('pending');
    expect(requests).toHaveLength(0);
    unsubscribes.push(observer.subscribe(() => undefined));
    await waitForRequests(1);
    requests[0]!.resolve(detail('ARCHIVED'));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED'));
  });

  it('leaves an absent detail absent and does not touch another workspace', async () => {
    await fixture(false);
    useProjectSnapshotSync('proj-1');
    const other = [['workspace', 'get'], { input: { id: 'other' }, type: 'query' }] as const;
    queryClient.setQueryData(other, detail());
    remove('absent');
    expect(queryClient.getQueryCache().findAll({ queryKey: [['workspace', 'get']] })).toHaveLength(
      2
    );
    expect(queryClient.getQueryData(other)).toMatchObject({ status: 'READY' });
    expect(utils.workspace.get.getData({ id: 'ws-1' })?.status).toBe('READY');
  });

  it('deduplicates removals until reintroduction, preserving deliberately reopened archived detail', async () => {
    const { observer } = await fixture();
    useProjectSnapshotSync('proj-1');
    remove();
    await waitForRequests(1);
    remove();
    requests[0]!.resolve(detail('ARCHIVED'));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED'));
    remove();
    expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED');
    expect(requests).toHaveLength(1);
    channel.onMessage!({ type: 'snapshot_changed', workspaceId: 'ws-1', entry: makeEntry() });
    expect(observer.getCurrentResult().data?.status).toBe('READY');
    remove();
    expect(observer.getCurrentResult().data).toBeUndefined();
    await waitForRequests(2);
  });

  it('resets a formerly live detail omitted from a full baseline', async () => {
    const { observer } = await fixture();
    useProjectSnapshotSync('proj-1');
    channel.onMessage!({ type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(utils.workspace.listForProject.getData({ projectId: 'proj-1' })?.workspaces).toEqual([]);
    await waitForRequests(1);
    requests[0]!.resolve(detail('ARCHIVED'));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED'));
  });

  it.each(['snapshot_changed', 'snapshot_full'] as const)(
    'cancels the removal fetch and fetches fresh full detail when %s reintroduces a workspace',
    async (type) => {
      const { observer, signals } = await fixture();
      useProjectSnapshotSync('proj-1');
      remove();
      await waitForRequests(1);
      channel.onMessage!(
        type === 'snapshot_full'
          ? { type, projectId: 'proj-1', entries: [makeEntry({ name: 'Restored' })] }
          : { type, workspaceId: 'ws-1', entry: makeEntry({ name: 'Restored' }) }
      );
      expect(signals[0]?.aborted).toBe(true);
      // A live summary cannot supply the missing DB-backed detail fields.
      expect(observer.getCurrentResult().data).toBeUndefined();
      await waitForRequests(2);
      requests[1]!.resolve({ ...detail(), name: 'Restored', githubIssueNumber: 42 });
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toMatchObject({
          status: 'READY',
          name: 'Restored',
          githubIssueNumber: 42,
        })
      );
      requests[0]!.resolve(detail('ARCHIVING'));
      await requests[0]!.promise;
      expect(observer.getCurrentResult().data?.status).toBe('READY');
      remove();
      expect(observer.getCurrentResult().data).toBeUndefined();
      await waitForRequests(3);
    }
  );

  it('resets same-project live detail omitted from a full baseline with an empty list cache', async () => {
    const { observer } = await fixture();
    useProjectSnapshotSync('proj-1');
    utils.workspace.listForProject.setData(
      { projectId: 'proj-1' },
      { workspaces: [], reviewCount: 0 }
    );
    channel.onMessage!({ type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    expect(observer.getCurrentResult().data).toBeUndefined();
    await waitForRequests(1);
    requests[0]!.resolve(detail('ARCHIVED'));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED'));
  });

  it('preserves intentionally opened hidden detail and other projects when a full baseline omits them', async () => {
    await fixture(false);
    useProjectSnapshotSync('proj-1');
    utils.workspace.listForProject.setData(
      { projectId: 'proj-1' },
      { workspaces: [], reviewCount: 0 }
    );
    utils.workspace.get.setData({ id: 'ws-1' }, detail('ARCHIVED'));
    utils.workspace.get.setData({ id: 'archiving' }, { ...detail('ARCHIVING'), id: 'archiving' });
    utils.workspace.get.setData(
      { id: 'other-project' },
      { ...detail(), id: 'other-project', projectId: 'proj-2' }
    );
    channel.onMessage!({ type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    expect(utils.workspace.get.getData({ id: 'ws-1' })?.status).toBe('ARCHIVED');
    expect(utils.workspace.get.getData({ id: 'archiving' })?.status).toBe('ARCHIVING');
    expect(utils.workspace.get.getData({ id: 'other-project' })?.status).toBe('READY');
    expect(requests).toHaveLength(0);
  });

  it('keeps inactive or absent reintroduced detail unfetched until opened', async () => {
    await fixture(false);
    useProjectSnapshotSync('proj-1');
    remove();
    remove('absent');
    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [makeEntry(), makeEntry({ workspaceId: 'absent' })],
    });
    expect(utils.workspace.get.getData({ id: 'ws-1' })).toBeUndefined();
    expect(utils.workspace.get.getData({ id: 'absent' })).toBeUndefined();
    expect(queryClient.getQueryCache().findAll({ queryKey: [['workspace', 'get']] })).toHaveLength(
      1
    );
    expect(requests).toHaveLength(0);
  });

  it('does not fabricate a missing detail when a full baseline introduces a workspace', async () => {
    await fixture(false);
    useProjectSnapshotSync('proj-1');
    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [makeEntry({ workspaceId: 'absent' })],
    });
    expect(utils.workspace.get.getData({ id: 'absent' })).toBeUndefined();
    expect(queryClient.getQueryCache().findAll({ queryKey: [['workspace', 'get']] })).toHaveLength(
      1
    );
  });
});
