// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectSnapshotSync } from '@/client/hooks/use-project-snapshot-sync';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  workspaceDetailQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import { useWorkspaceData } from '@/client/routes/projects/workspaces/use-workspace-detail';
import { useWorkspaceInitStatus } from '@/client/routes/projects/workspaces/use-workspace-detail-hooks';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

let channel: UseWebSocketTransportOptions;
vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (options: UseWebSocketTransportOptions) => {
    channel = options;
    return { connected: true, send: vi.fn(), reconnect: vi.fn() };
  },
}));

let queryClient: QueryClient;
let root: Root | undefined;
let latest: ReturnType<typeof useWorkspaceData>;
let initStatus = { status: 'PROVISIONING', hasWorktreePath: false, initOutput: '' };
const requests: Array<(data: WorkspaceDetail) => void> = [];
const detailKey = getQueryKey(trpc.workspace.get, { id: 'ws-1' }, 'query');
function fetched(overrides: Partial<WorkspaceDetail> = {}) {
  return unsafeCoerce<WorkspaceDetail>({
    ...projectSnapshotToWorkspace(entry()),
    prs: [],
    hasHadSessions: false,
    prUpdatedAt: null,
    worktreePath: '/ready/worktree',
    initOutput: 'setup completed',
    defaultSessionProvider: 'CODEX',
    agentSessions: [{ id: 'agent-1' }],
    terminalSessions: [{ id: 'term-1' }],
    ...overrides,
  });
}
function Harness() {
  const data = useWorkspaceData({ workspaceId: 'ws-1' });
  const utils = trpc.useUtils();
  useWorkspaceInitStatus('ws-1', data.workspace, utils);
  useProjectSnapshotSync('proj-1');
  useLayoutEffect(() => {
    latest = data;
  });
  return null;
}
function fixture(seed?: WorkspaceDetail) {
  requests.length = 0;
  initStatus = { status: 'PROVISIONING', hasWorktreePath: false, initOutput: '' };
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  if (seed) {
    queryClient.setQueryData(detailKey, seed);
  }
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const respond = (data: unknown) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            switch (op.path) {
              case 'workspace.get':
                requests.push(respond);
                break;
              case 'workspace.getInitStatus':
                respond(initStatus);
                break;
              case 'workspace.listForProject':
                respond({ workspaces: [], reviewCount: 0 });
                break;
              case 'session.listSessions':
                respond([]);
                break;
              case 'session.getMaxSessionsPerWorkspace':
                respond(5);
                break;
              default:
                throw new Error(`Unexpected request: ${op.path}`);
            }
          }),
    ],
  });
  root = createRoot(document.createElement('div'));
  flushSync(() =>
    root!.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
}
afterEach(async () => {
  flushSync(() => root?.unmount());
  root = undefined;
  await queryClient?.cancelQueries();
  queryClient?.clear();
});

describe('workspace detail route hydration', () => {
  it('retains loading until full HTTP detail arrives and overlays accepted stream fields', async () => {
    fixture();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'Stream', status: 'PROVISIONING' })],
    });
    expect(latest.workspace).toBeUndefined();
    expect(latest.workspaceLoading).toBe(true);
    requests[0]!(fetched({ name: 'Old HTTP' }));
    await vi.waitFor(() =>
      expect(latest.workspace).toMatchObject({
        name: 'Stream',
        status: 'PROVISIONING',
        worktreePath: '/ready/worktree',
        defaultSessionProvider: 'CODEX',
        agentSessions: [{ id: 'agent-1' }],
        terminalSessions: [{ id: 'term-1' }],
      })
    );
    expect(latest.workspaceLoading).toBe(false);
  });

  it('disconnects only its pending owned detail while other projects and unassociated detail keep loading', async () => {
    fixture();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    channel.onConnected?.();
    channel.onMessage!({ type: 'snapshot_full', projectId: 'proj-1', entries: [entry()] });
    const b = getProjectWorkspaceCacheReconciler(queryClient, 'proj-2');
    const bToken = b.beginConnection();
    b.apply(bToken, {
      type: 'snapshot_full',
      projectId: 'proj-2',
      entries: [entry({ workspaceId: 'ws-b', projectId: 'proj-2' })],
    });
    const signals: Record<string, AbortSignal[]> = { 'ws-b': [], 'ws-c': [] };
    const complete: Record<string, (data: WorkspaceDetail) => void> = {};
    const observers = ['ws-b', 'ws-c'].map(
      (id) =>
        new QueryObserver(
          queryClient,
          workspaceDetailQueryOptions(queryClient, id, (signal) => {
            signals[id]!.push(signal);
            return new Promise<WorkspaceDetail>((resolve) => {
              complete[id] = resolve;
            });
          })
        )
    );
    const unsubscribe = observers.map((observer) => observer.subscribe(() => undefined));
    try {
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      channel.onDisconnected?.();
      channel.onDisconnected?.();
      expect(signals['ws-b']![0]!.aborted).toBe(false);
      expect(signals['ws-c']![0]!.aborted).toBe(false);
      expect(signals['ws-b']).toHaveLength(1);
      expect(signals['ws-c']).toHaveLength(1);
      expect(invalidate).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      requests[1]!(fetched({ name: 'A fallback' }));
      await vi.waitFor(() => expect(latest.workspace?.name).toBe('A fallback'));
      complete['ws-b']!(fetched({ id: 'ws-b', projectId: 'proj-2', worktreePath: '/project-b' }));
      complete['ws-c']!(
        fetched({ id: 'ws-c', projectId: 'proj-3', worktreePath: '/unassociated-c' })
      );
      await vi.waitFor(() =>
        expect(observers[0]!.getCurrentResult().data?.worktreePath).toBe('/project-b')
      );
      expect(observers[1]!.getCurrentResult().data?.worktreePath).toBe('/unassociated-c');
    } finally {
      unsubscribe.forEach((stop) => stop());
    }
  });

  it('retries an active unassociated direct detail when its eventual project generation has retired', async () => {
    fixture();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    channel.onConnected?.();
    channel.onDisconnected?.();
    expect(requests).toHaveLength(1);
    requests[0]!(fetched({ worktreePath: '/retired/direct-link' }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(latest.workspace).toBeUndefined();
    expect(latest.workspaceLoading).toBe(true);
    expect(queryClient.getQueryState(detailKey)?.status).toBe('pending');
    requests[1]!(fetched({ name: 'Current direct link', worktreePath: '/current/direct-link' }));
    await vi.waitFor(() =>
      expect(latest.workspace).toMatchObject({
        name: 'Current direct link',
        worktreePath: '/current/direct-link',
      })
    );
  });

  it('keeps init-status readiness repair and polling while hydrating provisioned metadata', async () => {
    fixture(
      fetched({
        status: 'PROVISIONING',
        worktreePath: null,
        agentSessions: [],
        terminalSessions: [],
      })
    );
    const initKey = getQueryKey(trpc.workspace.getInitStatus, { id: 'ws-1' }, 'query');
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(initKey)).toMatchObject({ status: 'PROVISIONING' })
    );
    const query = queryClient.getQueryCache().find({ queryKey: initKey })!;
    const interval = unsafeCoerce<QueryObserverOptions>(query.options).refetchInterval;
    expect(typeof interval === 'function' ? interval(query) : interval).toBe(1000);
    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'Ready stream', status: 'READY' })],
    });
    initStatus = { status: 'READY', hasWorktreePath: true, initOutput: 'setup complete' };
    await queryClient.invalidateQueries({ queryKey: initKey, exact: true });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    for (const resolve of requests) {
      resolve(fetched({ status: 'PROVISIONING', name: 'Old HTTP' }));
    }
    await vi.waitFor(() =>
      expect(latest.workspace).toMatchObject({
        name: 'Ready stream',
        status: 'READY',
        worktreePath: '/ready/worktree',
        initOutput: 'setup completed',
        agentSessions: [{ id: 'agent-1' }],
        terminalSessions: [{ id: 'term-1' }],
      })
    );
    const readyInterval = unsafeCoerce<QueryObserverOptions>(query.options).refetchInterval;
    expect(typeof readyInterval === 'function' ? readyInterval(query) : readyInterval).toBe(false);
  });
});
