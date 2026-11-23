import { QueryClient, QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import type { AppRouter } from '@/client/lib/trpc';
import {
  type ProjectWorkspaceCache,
  projectWorkspaceQueryOptions,
  workspaceDetailQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';
import { createTestEventLog } from '@/test-utils/test-event-log';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  makeCompleteWorkspaceSnapshotEntry as complete,
  makeWorkspaceSnapshotEntry as legacy,
} from '@/test-utils/workspace-snapshot';
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

interface Read<T> {
  signal: AbortSignal;
  resolve: (value: T) => void;
}

const stops: Array<() => void> = [];

/** A mounted reader whose HTTP reads the test resolves. */
function mount<T>(options: (read: (signal: AbortSignal) => Promise<T>) => object, active = true) {
  const reads = createTestEventLog<Read<T>>();
  const observer = new QueryObserver<T, Error, T, T, readonly unknown[]>(
    queryClient,
    unsafeCoerce<QueryObserverOptions<T, Error, T, T, readonly unknown[]>>(
      options((signal) => {
        const read = Promise.withResolvers<T>();
        reads.record({ signal, resolve: read.resolve });
        return read.promise;
      })
    )
  );
  if (active) {
    stops.push(observer.subscribe(() => undefined));
  }
  stops.push(() => observer.destroy());
  return { observer, reads: reads.events, waitForReads: reads.waitForCount };
}

const listRow = (entry: WorkspaceSnapshotEntry, githubIssueNumber = 42) => ({
  ...projectSnapshotToWorkspace(entry),
  worktreePath: `/worktrees/${entry.workspaceId}`,
  githubIssueNumber,
});
function detail(entry: WorkspaceSnapshotEntry, description = 'HTTP detail') {
  return unsafeCoerce<WorkspaceDetail>({ ...listRow(entry), description, agentSessions: [] });
}

/**
 * Board with a mounted workspace page: one list, one active and one cached
 * inactive detail, after the snapshot hook has connected and taken its first
 * baseline.
 */
async function openBoard(entries: WorkspaceSnapshotEntry[]) {
  const list = mount<ProjectWorkspaceCache>((read) =>
    projectWorkspaceQueryOptions(queryClient, 'proj-1', read)
  );
  const page = mount<WorkspaceDetail>((read) =>
    workspaceDetailQueryOptions(queryClient, entries[0]!.workspaceId, read)
  );
  const background = mount<WorkspaceDetail>(
    (read) => workspaceDetailQueryOptions(queryClient, entries[1]!.workspaceId, read),
    false
  );
  utils.workspace.get.setData({ id: entries[1]!.workspaceId }, detail(entries[1]!));
  channel.onConnected?.();
  list.reads[0]!.resolve({ workspaces: entries.map((entry) => listRow(entry)), reviewCount: 0 });
  page.reads[0]!.resolve(detail(entries[0]!));
  await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
  channel.onMessage!({ type: 'snapshot_full', projectId: 'proj-1', entries, reviewCount: 0 });
  expect(list.reads).toHaveLength(1);
  expect(page.reads).toHaveLength(1);
  return { list, page, background };
}

const boardRows = () =>
  utils.workspace.listForProject
    .getData({ projectId: 'proj-1' })
    ?.workspaces.map(({ id, name, githubIssueNumber }) => ({ id, name, githubIssueNumber }));

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const client = createTRPCClient<AppRouter>({
    links: [httpLink({ url: 'http://127.0.0.1/unused', transformer: superjson })],
  });
  utils = createTRPCQueryUtils({ client, queryClient });
});

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
  queryClient.clear();
});

describe('snapshot reconnect requests', () => {
  it('lets a complete baseline carry the board after a drop, refetching only the mounted detail', async () => {
    const [kept, archived] = [complete({ workspaceId: 'ws-1' }), complete({ workspaceId: 'ws-2' })];
    useProjectSnapshotSync('proj-1');
    const { list, page, background } = await openBoard([kept, archived]);

    channel.onDisconnected?.();
    channel.onConnected?.();
    expect(list.reads).toHaveLength(1);
    expect(page.reads).toHaveLength(1);

    // During the gap ws-1 was renamed and relinked, ws-2 archived and ws-3 created.
    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [
        complete({ workspaceId: 'ws-1', name: 'renamed', githubIssueNumber: 7 }),
        complete({ workspaceId: 'ws-3', name: 'created', githubIssueNumber: 9 }),
      ],
      reviewCount: 2,
    });
    expect(boardRows()).toEqual([
      { id: 'ws-1', name: 'renamed', githubIssueNumber: 7 },
      { id: 'ws-3', name: 'created', githubIssueNumber: 9 },
    ]);
    expect(utils.workspace.listForProject.getData({ projectId: 'proj-1' })?.reviewCount).toBe(2);
    expect(page.observer.getCurrentResult().data?.name).toBe('renamed');

    // Detail carries database fields no snapshot entry has, so the mounted page reads once.
    await page.waitForReads(2);
    page.reads[1]!.resolve(detail(complete({ workspaceId: 'ws-1' }), 'Edited during the gap'));
    await vi.waitFor(() =>
      expect(page.observer.getCurrentResult().data).toMatchObject({
        name: 'renamed',
        description: 'Edited during the gap',
      })
    );
    expect(list.reads).toHaveLength(1);
    expect(page.reads).toHaveLength(2);
    // The archived workspace's unmounted detail is reset, not read.
    expect(background.reads).toHaveLength(0);
    expect(background.observer.getCurrentQuery().state.data).toBeUndefined();
  });

  it('refetches the list once when the baseline after a drop has a legacy entry', async () => {
    useProjectSnapshotSync('proj-1');
    const { list, page } = await openBoard([
      complete({ workspaceId: 'ws-1' }),
      legacy({ workspaceId: 'ws-2' }),
    ]);
    channel.onDisconnected?.();
    channel.onConnected?.();
    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [complete({ workspaceId: 'ws-1' }), legacy({ workspaceId: 'ws-2', name: 'live' })],
      reviewCount: 0,
    });
    await list.waitForReads(2);
    list.reads[1]!.resolve({
      workspaces: [
        listRow(complete({ workspaceId: 'ws-1' })),
        listRow(legacy({ workspaceId: 'ws-2' }), 5),
      ],
      reviewCount: 0,
    });
    await vi.waitFor(() =>
      expect(boardRows()).toContainEqual({ id: 'ws-2', name: 'live', githubIssueNumber: 5 })
    );
    await page.waitForReads(2);
    expect(list.reads).toHaveLength(2);
    expect(page.reads).toHaveLength(2);
  });

  it('falls back to HTTP once when the reconnect attempt fails', async () => {
    useProjectSnapshotSync('proj-1');
    const { list, page } = await openBoard([
      complete({ workspaceId: 'ws-1' }),
      complete({ workspaceId: 'ws-2' }),
    ]);
    channel.onDisconnected?.();
    expect(list.reads).toHaveLength(1);
    expect(page.reads).toHaveLength(1);

    channel.onDisconnected?.();
    await list.waitForReads(2);
    await page.waitForReads(2);
    channel.onDisconnected?.();
    expect(list.reads).toHaveLength(2);
    expect(page.reads).toHaveLength(2);
    list.reads[1]!.resolve({
      workspaces: [listRow(complete({ workspaceId: 'ws-1', name: 'from HTTP' }))],
      reviewCount: 0,
    });
    await vi.waitFor(() =>
      expect(boardRows()).toEqual([{ id: 'ws-1', name: 'from HTTP', githubIssueNumber: 42 }])
    );
  });

  it('restarts a read the dropped connection began once, without reading it again at the baseline', async () => {
    useProjectSnapshotSync('proj-1');
    const { list, page } = await openBoard([
      complete({ workspaceId: 'ws-1' }),
      complete({ workspaceId: 'ws-2' }),
    ]);
    void utils.workspace.listForProject.invalidate({ projectId: 'proj-1' });
    await list.waitForReads(2);

    channel.onDisconnected?.();
    await list.waitForReads(3);
    expect(list.reads[1]!.signal.aborted).toBe(true);
    channel.onConnected?.();
    await list.waitForReads(4);
    expect(list.reads[2]!.signal.aborted).toBe(true);

    channel.onMessage!({
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [complete({ workspaceId: 'ws-1' }), complete({ workspaceId: 'ws-2' })],
      reviewCount: 0,
    });
    list.reads[3]!.resolve({ workspaces: [], reviewCount: 0 });
    await page.waitForReads(2);
    page.reads[1]!.resolve(detail(complete({ workspaceId: 'ws-1' })));
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(list.reads).toHaveLength(4);
    expect(page.reads).toHaveLength(2);
    expect(boardRows()?.map((row) => row.id)).toEqual(['ws-1', 'ws-2']);
  });
});
