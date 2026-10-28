import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import type { AppRouter } from '@/client/lib/trpc';
import { workspaceDetailQueryOptions } from '@/client/lib/workspace-cache-reconciler';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { makeCompleteWorkspaceSnapshotEntry as complete } from '@/test-utils/workspace-snapshot';
import { useProjectSnapshotSync } from './use-project-snapshot-sync';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useCallback: (fn: (...args: never[]) => unknown) => fn,
  useRef: <T>(value: T) => ({ current: value }),
  useMemo: <T>(factory: () => T) => factory(),
  useEffect: (effect: () => unknown) => {
    effect();
  },
}));

let channel: UseWebSocketTransportOptions;
vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (options: UseWebSocketTransportOptions) => {
    channel = options;
    return { connected: true, send: vi.fn(), reconnect: vi.fn() };
  },
}));
let utils: ReturnType<typeof createTRPCQueryUtils<AppRouter>>;
let queryClient: QueryClient;
vi.mock('@/client/lib/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/client/lib/trpc')>();
  return { ...actual, trpc: { workspace: actual.trpc.workspace, useUtils: () => utils } };
});
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => queryClient,
}));

const observers: Array<{ destroy(): void }> = [];
const unsubscribes: Array<() => void> = [];
function detail(id: string, projectId = 'proj-1', overrides: Partial<WorkspaceDetail> = {}) {
  return unsafeCoerce<WorkspaceDetail>({
    ...projectSnapshotToWorkspace(complete({ workspaceId: id, projectId })),
    initOutput: `Cached ${id}`,
    defaultSessionProvider: 'CLAUDE',
    ...overrides,
  });
}

function observe(id: string, cached?: WorkspaceDetail, active = true) {
  const requests: Array<{
    signal: AbortSignal;
    resolve: (value: WorkspaceDetail) => void;
  }> = [];
  if (cached) {
    utils.workspace.get.setData({ id }, cached);
  }
  const options = workspaceDetailQueryOptions(queryClient, id, (signal) => {
    const request = Promise.withResolvers<WorkspaceDetail>();
    requests.push({ signal, resolve: request.resolve });
    return request.promise;
  });
  const observer = new QueryObserver(queryClient, options);
  observers.push(observer);
  const rendered: Array<WorkspaceDetail | undefined> = [];
  if (active) {
    unsubscribes.push(observer.subscribe((result) => rendered.push(result.data)));
  }
  return { observer, requests, rendered, key: options.queryKey };
}

function baseline(entries: ReturnType<typeof complete>[] = []) {
  channel.onMessage!({ type: 'snapshot_full', projectId: 'proj-1', entries });
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  // No list observer fetches HTTP; detail fetchers below expose deferred requests.
  const client = createTRPCClient<AppRouter>({
    links: [httpLink({ url: 'http://127.0.0.1/unused', transformer: superjson })],
  });
  utils = createTRPCQueryUtils({ client, queryClient });
});

afterEach(() => {
  for (const stop of unsubscribes.splice(0)) {
    stop();
  }
  for (const observer of observers.splice(0)) {
    observer.destroy();
  }
  queryClient.clear();
  vi.restoreAllMocks();
});

describe('project reconnect detail healing with real queries', () => {
  it('refreshes only owned active metadata and invalidates only owned inactive details on later baselines', async () => {
    const activeA = observe('active-a', detail('active-a'));
    const inactiveA = observe('inactive-a', detail('inactive-a'), false);
    const archivedA = observe('archived-a', detail('archived-a', 'proj-1', { status: 'ARCHIVED' }));
    const activeB = observe('active-b', detail('active-b', 'proj-2'));
    const inactiveB = observe('inactive-b', detail('inactive-b', 'proj-2'), false);
    const entries = ['active-a', 'inactive-a'].map((workspaceId) => complete({ workspaceId }));
    utils.workspace.listForProject.setData(
      { projectId: 'proj-1' },
      { workspaces: entries.map((entry) => projectSnapshotToWorkspace(entry)), reviewCount: 0 }
    );
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    useProjectSnapshotSync('proj-1');
    baseline(entries);
    expect(invalidations).not.toHaveBeenCalled();
    expect(activeA.requests).toHaveLength(0);
    expect(archivedA.requests).toHaveLength(0);

    baseline(entries);
    expect(activeA.requests).toHaveLength(1);
    expect(archivedA.requests).toHaveLength(1);
    expect(inactiveA.requests).toHaveLength(0);
    expect(queryClient.getQueryState(inactiveA.key)?.isInvalidated).toBe(true);
    expect(activeB.requests).toHaveLength(0);
    expect(inactiveB.requests).toHaveLength(0);
    expect(queryClient.getQueryState(activeB.key)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(inactiveB.key)?.isInvalidated).toBe(false);
    expect(activeB.observer.getCurrentResult().data?.initOutput).toBe('Cached active-b');
    expect(queryClient.getQueryData<WorkspaceDetail>(inactiveB.key)?.initOutput).toBe(
      'Cached inactive-b'
    );
    expect(
      queryClient.getQueryState([
        ['workspace', 'listForProject'],
        { input: { projectId: 'proj-1' }, type: 'query' },
      ])?.isInvalidated
    ).toBe(true);

    // Check the actual healing predicate against real query objects as well as its effects.
    const filter = invalidations.mock.calls[0]![0]!;
    for (const target of [activeA, inactiveA, archivedA]) {
      expect(filter.predicate?.(queryClient.getQueryCache().find({ queryKey: target.key })!)).toBe(
        true
      );
    }
    for (const target of [activeB, inactiveB]) {
      expect(filter.predicate?.(queryClient.getQueryCache().find({ queryKey: target.key })!)).toBe(
        false
      );
    }
    activeA.requests[0]!.resolve(
      detail('active-a', 'proj-1', { initOutput: 'Fresh active metadata' })
    );
    archivedA.requests[0]!.resolve(
      detail('archived-a', 'proj-1', { status: 'ARCHIVED', initOutput: 'Fresh archived metadata' })
    );
    await vi.waitFor(() => {
      expect(activeA.observer.getCurrentResult().data?.initOutput).toBe('Fresh active metadata');
      expect(archivedA.observer.getCurrentResult().data).toMatchObject({
        status: 'ARCHIVED',
        initOutput: 'Fresh archived metadata',
      });
    });
    expect(activeA.requests[0]?.signal.aborted).toBe(false);
  });

  it('retains owned detail evidence after its data and live list are cleared', () => {
    const retained = observe(
      'retained',
      detail('retained', 'proj-1', { status: 'ARCHIVED' }),
      false
    );
    void queryClient.resetQueries({ queryKey: retained.key, exact: true });
    expect(queryClient.getQueryData(retained.key)).toBeUndefined();
    useProjectSnapshotSync('proj-1');
    baseline();
    expect(queryClient.getQueryState(retained.key)?.isInvalidated).toBe(false);
    baseline();
    expect(queryClient.getQueryState(retained.key)?.isInvalidated).toBe(true);
    expect(retained.requests).toHaveLength(0);
  });

  it.each(['proj-1', 'proj-2'] as const)(
    'keeps an unknown pending %s direct link independent through A reconnect, then validates its commit epoch',
    async (responseProject) => {
      useProjectSnapshotSync('proj-1');
      channel.onConnected?.();
      baseline();
      const unknown = observe('unknown');
      expect(unknown.requests).toHaveLength(1);
      expect(unknown.observer.getCurrentResult()).toMatchObject({
        status: 'pending',
        fetchStatus: 'fetching',
      });
      channel.onDisconnected?.();
      channel.onConnected?.();
      baseline();
      expect(unknown.requests).toHaveLength(1);
      expect(unknown.requests[0]?.signal.aborted).toBe(false);
      expect(queryClient.getQueryState(unknown.key)?.isInvalidated).toBe(false);
      expect(queryClient.getQueryData(unknown.key)).toBeUndefined();

      unknown.requests[0]!.resolve(
        detail('unknown', responseProject, { initOutput: 'Old epoch response' })
      );
      if (responseProject === 'proj-1') {
        // Ownership is learned only at HTTP resolution. The old response reaches
        // the actual Query success commit, where provenance rejects its epoch.
        await vi.waitFor(() => expect(unknown.requests).toHaveLength(2));
        expect(queryClient.getQueryData(unknown.key)).toBeUndefined();
        expect(unknown.rendered.every((value) => value === undefined)).toBe(true);
        expect(unknown.observer.getCurrentResult()).toMatchObject({
          status: 'pending',
          fetchStatus: 'fetching',
        });
        unknown.requests[1]!.resolve(
          detail('unknown', 'proj-1', { initOutput: 'Current epoch metadata' })
        );
        await vi.waitFor(() =>
          expect(unknown.observer.getCurrentResult().data?.initOutput).toBe(
            'Current epoch metadata'
          )
        );
        expect(unknown.requests).toHaveLength(2);
        expect(unknown.rendered.some((value) => value?.initOutput === 'Old epoch response')).toBe(
          false
        );
      } else {
        await vi.waitFor(() =>
          expect(unknown.observer.getCurrentResult().data).toMatchObject({
            projectId: 'proj-2',
            initOutput: 'Old epoch response',
          })
        );
        expect(unknown.requests).toHaveLength(1);
        expect(unknown.requests[0]?.signal.aborted).toBe(false);
        expect(queryClient.getQueryState(unknown.key)?.isInvalidated).toBe(false);
      }
    }
  );
});
