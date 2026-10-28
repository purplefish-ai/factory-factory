// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import { initTRPC } from '@trpc/server';
import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useProjectSnapshotSync } from '@/client/hooks/use-project-snapshot-sync';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
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
  return { ...actual, trpc: { workspace: actual.trpc.workspace, useUtils: () => utils } };
});
const row = (status: 'READY' | 'ARCHIVED' = 'READY') =>
  projectSnapshotToWorkspace(entry({ status }));
const t = initTRPC.create({ transformer: superjson });
const router = t.router({
  workspace: t.router({
    listForProject: t.procedure.input(z.object({ projectId: z.string() })).query(() => ({
      workspaces: [row()],
      reviewCount: 0,
    })),
    get: t.procedure.input(z.object({ id: z.string() })).query(() => row()),
  }),
});
type FixtureRouter = typeof router;
let utils: ReturnType<typeof createTRPCQueryUtils<FixtureRouter>>;
let queryClient: QueryClient;
let root: Root | undefined;
const clients: QueryClient[] = [];
const additionalRoots: Root[] = [];

function Harness({ projectId }: { projectId: string }) {
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
function bindClient() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(queryClient);
  const client = createTRPCClient<FixtureRouter>({
    links: [httpLink({ url: 'http://127.0.0.1/unused', transformer: superjson })],
  });
  utils = createTRPCQueryUtils({ client, queryClient });
}
function fixture() {
  bindClient();
  root = createRoot(document.createElement('div'));
  render();
  channel.onConnected?.();
}
const remove = () => channel.onMessage?.({ type: 'snapshot_removed', workspaceId: 'ws-1' });
const reopen = () => utils.workspace.get.setData({ id: 'ws-1' }, row('ARCHIVED'));
const expectArchived = () =>
  expect(utils.workspace.get.getData({ id: 'ws-1' })?.status).toBe('ARCHIVED');
afterEach(async () => {
  flushSync(() => {
    root?.unmount();
    for (const additionalRoot of additionalRoots.splice(0)) {
      additionalRoot.unmount();
    }
  });
  root = undefined;
  for (const client of clients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  vi.restoreAllMocks();
});

describe('snapshot detail history in a real hook mount', () => {
  it('retains history through reconnect and A to B to A', () => {
    fixture();
    const reset = vi.spyOn(queryClient, 'resetQueries');
    utils.workspace.get.setData({ id: 'ws-1' }, row());
    remove();
    expect(reset).toHaveBeenCalledTimes(1);
    reopen();
    remove();
    channel.onDisconnected?.();
    channel.onConnected?.();
    remove();
    expectArchived();
    render('proj-2');
    channel.onConnected?.();
    render('proj-1');
    channel.onConnected?.();
    remove();
    expect(reset).toHaveBeenCalledTimes(1);
    expectArchived();
  });

  it('starts fresh history after actual unmount and remount on the same client', () => {
    fixture();
    const reset = vi.spyOn(queryClient, 'resetQueries');
    utils.workspace.get.setData({ id: 'ws-1' }, row());
    remove();
    reopen();
    flushSync(() => root!.unmount());
    root = createRoot(document.createElement('div'));
    render();
    channel.onConnected?.();
    remove();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(utils.workspace.get.getData({ id: 'ws-1' })).toBeUndefined();
  });

  it('keeps independent mounted hook histories and rejects superseded callbacks', () => {
    fixture();
    const reset = vi.spyOn(queryClient, 'resetQueries');
    utils.workspace.get.setData({ id: 'ws-1' }, row());
    remove();
    reopen();
    const first = channel;
    const secondRoot = createRoot(document.createElement('div'));
    additionalRoots.push(secondRoot);
    flushSync(() =>
      secondRoot.render(
        <QueryClientProvider client={queryClient}>
          <Harness projectId="proj-1" />
        </QueryClientProvider>
      )
    );
    channel.onConnected?.();
    first.onMessage?.({ type: 'snapshot_removed', workspaceId: 'ws-1' });
    expect(reset).toHaveBeenCalledTimes(1);
    expectArchived();
    remove();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(utils.workspace.get.getData({ id: 'ws-1' })).toBeUndefined();
  });

  it('preserves history after real StrictMode effect replay', () => {
    fixture();
    flushSync(() => root!.unmount());
    root = createRoot(document.createElement('div'));
    flushSync(() =>
      root!.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <Harness projectId="proj-1" />
          </QueryClientProvider>
        </StrictMode>
      )
    );
    channel.onConnected?.();
    const reset = vi.spyOn(queryClient, 'resetQueries');
    utils.workspace.get.setData({ id: 'ws-1' }, row());
    remove();
    reopen();
    remove();
    expect(reset).toHaveBeenCalledTimes(1);
    expectArchived();
  });

  it('retains mount history when the provider replaces its QueryClient', () => {
    fixture();
    remove();
    bindClient();
    reopen();
    render();
    channel.onConnected?.();
    const reset = vi.spyOn(queryClient, 'resetQueries');
    remove();
    expect(reset).not.toHaveBeenCalled();
    expectArchived();
    channel.onMessage?.({
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'live on new client' }),
    });
    expect(utils.workspace.get.getData({ id: 'ws-1' })?.name).toBe('live on new client');
    remove();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(utils.workspace.get.getData({ id: 'ws-1' })).toBeUndefined();
  });

  it('resets full omissions before list commit, then schedules legacy repair before live detail', () => {
    fixture();
    utils.workspace.listForProject.setData(
      { projectId: 'proj-1' },
      { workspaces: [row()], reviewCount: 0 }
    );
    utils.workspace.get.setData({ id: 'ws-1' }, row());
    utils.workspace.get.setData({ id: 'omitted' }, { ...row(), id: 'omitted' });
    const trace: string[] = [];
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((...args) => {
      trace.push('repair');
      return invalidate(...args);
    });
    const unsubscribe = queryClient.getQueryCache().subscribe(({ query, type }) => {
      if (type !== 'updated') {
        return;
      }
      const key = query.queryKey as [string[], { input: { id?: string } }];
      if (key[0][1] === 'listForProject' && !query.state.isInvalidated) {
        trace.push('list');
      } else if (key[1].input.id === 'omitted' && query.state.data === undefined) {
        trace.push('departure');
      } else if (key[1].input.id === 'ws-1') {
        trace.push('live');
      }
    });
    channel.onMessage?.({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'live' })],
    });
    unsubscribe();
    expect(trace).toEqual(['departure', 'list', 'repair', 'live']);
    expect(utils.workspace.get.getData({ id: 'omitted' })).toBeUndefined();
    expect(utils.workspace.get.getData({ id: 'ws-1' })?.name).toBe('live');
  });
});
