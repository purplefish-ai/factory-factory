// @vitest-environment jsdom
import type { Server } from 'node:http';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import { initTRPC } from '@trpc/server';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useProjectSnapshotSync } from '@/client/hooks/use-project-snapshot-sync';
import { useProjectWorkspaceQuery } from '@/client/hooks/use-project-workspace-query';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { projectWorkspaceQueryOptions } from '@/client/lib/workspace-cache-reconciler';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

let channel: UseWebSocketTransportOptions;
vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (options: UseWebSocketTransportOptions) => {
    channel = options;
    return { connected: true, send: vi.fn(), reconnect: vi.fn() };
  },
}));
vi.mock('@/client/lib/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/client/lib/trpc')>();
  return { ...actual, trpc: { workspace: actual.trpc.workspace, useUtils: () => context } };
});

const list = (name = 'http', projectId = 'proj-1') => ({
  workspaces: [
    {
      ...projectSnapshotToWorkspace(entry({ name, projectId })),
      worktreePath: '/actual/worktree',
      githubIssueNumber: 42,
    },
  ],
  reviewCount: 99,
});
const requests: Array<{ projectId: string; resolve: (value: ReturnType<typeof list>) => void }> =
  [];
const t = initTRPC.create({ transformer: superjson });
const router = t.router({
  workspace: t.router({
    listForProject: t.procedure.input(z.object({ projectId: z.string() })).query(
      ({ input }) =>
        new Promise<ReturnType<typeof list>>((resolve) => {
          requests.push({ ...input, resolve });
        })
    ),
    get: t.procedure.input(z.object({ id: z.string() })).query(() => list().workspaces[0]!),
  }),
});
type FixtureRouter = typeof router;
let client: ReturnType<typeof createTRPCClient<FixtureRouter>>;
let utils: ReturnType<typeof createTRPCQueryUtils<FixtureRouter>>;
let context: { workspace: typeof utils.workspace; client: typeof client };
let queryClient: QueryClient;
let server: Server | undefined;
let root: Root | undefined;

function Harness({ projectId }: { projectId: string }) {
  useProjectWorkspaceQuery(projectId);
  useProjectSnapshotSync(projectId);
  return null;
}
function render(projectId = 'proj-1') {
  flushSync(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Harness projectId={projectId} />
      </QueryClientProvider>
    )
  );
}
async function fixture() {
  requests.length = 0;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server = createHTTPServer({ router });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP fixture');
  }
  client = createTRPCClient<FixtureRouter>({
    links: [httpLink({ url: `http://127.0.0.1:${address.port}`, transformer: superjson })],
  });
  utils = createTRPCQueryUtils({ client, queryClient });
  context = { workspace: utils.workspace, client };
  root = createRoot(document.createElement('div'));
  render();
  channel.onConnected?.();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
}
async function waitForRequests(count: number) {
  await vi.waitFor(() => expect(requests).toHaveLength(count));
}
afterEach(async () => {
  flushSync(() => root?.unmount());
  root = undefined;
  await queryClient?.cancelQueries();
  queryClient?.clear();
  for (const request of requests) {
    request.resolve(list('cleanup', request.projectId));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

describe('shared project query and live connection lifecycle', () => {
  it('protects a real initial HTTP response arriving after full and changed snapshots', async () => {
    await fixture();
    channel.onMessage?.({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'full' })],
      reviewCount: 3,
    });
    channel.onMessage?.({
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'newest' }),
      reviewCount: 4,
    });
    await waitForRequests(2);
    requests[0]!.resolve(list('old bootstrap'));
    requests[1]!.resolve(list('old repair'));
    await vi.waitFor(() =>
      expect(utils.workspace.listForProject.getData({ projectId: 'proj-1' })).toMatchObject({
        workspaces: [{ name: 'newest', githubIssueNumber: 42 }],
        reviewCount: 4,
      })
    );
  });

  it('protects an empty full against late HTTP membership', async () => {
    await fixture();
    channel.onMessage?.({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [],
      reviewCount: 0,
    });
    requests[0]!.resolve(list());
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(utils.workspace.listForProject.getData({ projectId: 'proj-1' })).toEqual({
      workspaces: [],
      reviewCount: 0,
    });
  });

  it('invalidates fallback once per disconnect and rejects retired callbacks before a lower-version baseline', async () => {
    await fixture();
    requests[0]!.resolve(list());
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    channel.onMessage?.({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'old', version: 99 })],
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    channel.onDisconnected?.();
    channel.onDisconnected?.();
    expect(invalidate).toHaveBeenCalledTimes(1);
    channel.onMessage?.({ type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    await waitForRequests(2);
    requests[1]!.resolve(list('fallback'));
    await vi.waitFor(() =>
      expect(
        utils.workspace.listForProject.getData({ projectId: 'proj-1' })?.workspaces[0]?.name
      ).toBe('fallback')
    );
    channel.onConnected?.();
    expect(invalidate).toHaveBeenCalledTimes(1);
    channel.onMessage?.({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'restarted', version: 1 })],
      reviewCount: 1,
    });
    expect(
      utils.workspace.listForProject.getData({ projectId: 'proj-1' })?.workspaces[0]?.name
    ).toBe('restarted');
  });

  it('retires A callbacks through A→B→A, without losing a new A HTTP seed', async () => {
    await fixture();
    requests[0]!.resolve(list());
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    channel.onMessage?.({ type: 'snapshot_full', projectId: 'proj-1', entries: [entry()] });
    const oldA = channel;
    render('proj-2');
    channel.onConnected?.();
    await waitForRequests(2);
    requests[1]!.resolve(list('B', 'proj-2'));
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    render('proj-1');
    channel.onConnected?.();
    await waitForRequests(3);
    oldA.onMessage?.({ type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    oldA.onDisconnected?.();
    oldA.onConnected?.();
    requests[2]!.resolve(list('new A'));
    await vi.waitFor(() =>
      expect(
        utils.workspace.listForProject.getData({ projectId: 'proj-1' })?.workspaces[0]?.name
      ).toBe('new A')
    );
    expect(
      utils.workspace.listForProject.getData({ projectId: 'proj-2' })?.workspaces[0]?.name
    ).toBe('B');
  });

  it('shares the original tRPC query key with imperative invalidation and cached fetches', async () => {
    await fixture();
    requests[0]!.resolve(list());
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const fetch = vi.fn(() => Promise.resolve(list('unexpected')));
    const cached = await queryClient.fetchQuery(
      projectWorkspaceQueryOptions(queryClient, 'proj-1', fetch)
    );
    expect(cached.workspaces[0]?.name).toBe('http');
    expect(fetch).not.toHaveBeenCalled();
    expect(queryClient.getQueryCache().findAll()).toHaveLength(1);
  });
});
