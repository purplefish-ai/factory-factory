// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { act, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceArchiveCommand } from '@/client/features/workspace/use-workspace-archive-command';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
  type ProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-reconciler';
import { useSessionManagement } from '@/client/routes/projects/workspaces/use-workspace-detail';
import { useArchivedWorkspaceRedirect } from '@/client/routes/projects/workspaces/use-workspace-detail-hooks';
import { ARCHIVE_MANY_MAX_IDS } from '@/shared/workspace-archive';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const roots: Root[] = [];
const clients: QueryClient[] = [];
const subscriptions: (() => void)[] = [];
const ideAvailabilityKey = getQueryKey(trpc.workspace.getAvailableIdes, undefined, 'query');
afterEach(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function CommandProbe({
  onResult,
}: {
  onResult: (command: ReturnType<typeof useWorkspaceArchiveCommand>) => void;
}) {
  onResult(useWorkspaceArchiveCommand());
  return null;
}
function LocationProbe({ onLocation }: { onLocation: (location: string) => void }) {
  onLocation(useLocation().pathname);
  return null;
}
function RouteProbe({
  workspaceId,
  status,
  onResult,
  locked,
}: {
  workspaceId: string;
  status: 'READY' | 'ARCHIVING' | 'ARCHIVED' | undefined;
  onResult: (route: ReturnType<typeof useSessionManagement>) => void;
  locked: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const route = useSessionManagement({
    workspaceId,
    slug: 'project',
    sessions: [],
    inputRef,
    selectedDbSessionId: null,
    setSelectedDbSessionId: vi.fn(),
    onArchiveGitIndexLocked: locked,
  });
  useArchivedWorkspaceRedirect({
    status,
    slug: 'project',
    archivePending: route.archiveWorkspace.isPending,
  });
  useLayoutEffect(() => {
    onResult(route);
  }, [onResult, route]);
  return null;
}

async function commitReactUpdate<T>(update: () => T | Promise<T>): Promise<T> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    return await act(async () => update());
  } finally {
    vi.unstubAllGlobals();
  }
}

function fixture(surface: 'command' | 'route' = 'command', availabilityFailure = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
  const token = owner.beginConnection();
  owner.apply(token, {
    type: 'snapshot_full',
    projectId: 'proj-1',
    entries: [entry(), entry({ workspaceId: 'ws-2' })],
  });
  queryClient.setQueryData(getQueryKey(trpc.workspace.get, { id: 'ws-1' }, 'query'), {
    projectId: 'proj-1',
  });
  const availabilityFailed = Promise.withResolvers<void>();
  if (availabilityFailure) {
    const queryCache = queryClient.getQueryCache();
    const unsubscribe = queryCache.subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'error' &&
        event.query === queryCache.find({ queryKey: ideAvailabilityKey, exact: true })
      ) {
        availabilityFailed.resolve();
        unsubscribe();
      }
    });
    subscriptions.push(unsubscribe);
  }
  const requestWaiters = new Map<number, () => void>();
  const requests: {
    path: string;
    input: unknown;
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  const waitForRequests = async (count = 1) => {
    if (requests.length < count) {
      const started = Promise.withResolvers<void>();
      requestWaiters.set(count, started.resolve);
      await started.promise;
    }
    expect(requests).toHaveLength(count);
  };
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const respond = (data: unknown) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            if (op.type === 'mutation') {
              requests.push({
                path: op.path,
                input: op.input,
                resolve: respond,
                reject: (error) => observer.error(TRPCClientError.from(error)),
              });
              requestWaiters.get(requests.length)?.();
              requestWaiters.delete(requests.length);
            } else if (availabilityFailure && op.path === 'workspace.getAvailableIdes') {
              observer.error(TRPCClientError.from(new Error('IDE availability failed')));
            } else {
              respond({ ides: [{ id: 'code', name: 'VS Code' }], preferredIde: 'code' });
            }
          }),
    ],
  });
  let command!: ReturnType<typeof useWorkspaceArchiveCommand>;
  let route!: ReturnType<typeof useSessionManagement>;
  let location = '';
  const availabilityRendered = Promise.withResolvers<void>();
  const locked = vi.fn();
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = (workspaceId = 'ws-1', status?: 'READY' | 'ARCHIVING' | 'ARCHIVED') =>
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <trpc.Provider client={client} queryClient={queryClient}>
            <MemoryRouter initialEntries={['/detail']}>
              <LocationProbe
                onLocation={(nextLocation) => {
                  location = nextLocation;
                }}
              />
              {surface === 'command' ? (
                <CommandProbe
                  onResult={(value) => {
                    command = value;
                  }}
                />
              ) : (
                <Routes>
                  <Route
                    path="/detail"
                    element={
                      <RouteProbe
                        workspaceId={workspaceId}
                        status={status}
                        locked={locked}
                        onResult={(value) => {
                          route = value;
                          if (value.availableIdes.length > 0) {
                            availabilityRendered.resolve();
                          }
                        }}
                      />
                    }
                  />
                  <Route path="*" element={null} />
                </Routes>
              )}
            </MemoryRouter>
          </trpc.Provider>
        </QueryClientProvider>
      )
    );
  render();
  return {
    queryClient,
    owner,
    token,
    requests,
    waitForRequests,
    availabilityFailed: availabilityFailed.promise,
    availabilityRendered: availabilityRendered.promise,
    render,
    startRouteArchive: async (
      input: Parameters<typeof route.archiveWorkspace.mutate>[0],
      options?: Parameters<typeof route.archiveWorkspace.mutate>[1]
    ) => {
      await commitReactUpdate(async () => {
        route.archiveWorkspace.mutate(input, options);
        await waitForRequests();
      });
    },
    command: () => command,
    route: () => route,
    location: () => location,
    locked,
    rows: () => queryClient.getQueryData<ProjectWorkspaceCache>(owner.queryKey)!.workspaces,
  };
}

describe('shared archive command with real QueryClient/tRPC mutations', () => {
  it('omits removeGitIndexLock from the default single archive payload', async () => {
    const f = fixture();
    const run = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    await f.waitForRequests();
    expect(f.requests[0]?.input).toEqual({ id: 'ws-1' });
    f.requests[0]!.resolve({ id: 'ws-1' });
    await run;
  });

  it('refreshes the settled setup log status so the archived state shows', async () => {
    const f = fixture();
    const invalidate = vi.spyOn(f.queryClient, 'invalidateQueries');
    const run = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    await f.waitForRequests();
    f.requests[0]!.resolve({ id: 'ws-1' });
    await run;

    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: getQueryKey(trpc.workspace.getInitStatus, { id: 'ws-1' }, 'any'),
      }),
      undefined
    );
  });

  it.each(['single', 'bulk'])(
    'keeps %s pending while an older overlapping execution remains',
    async (kind) => {
      const f = fixture();
      const execute = (id: string) =>
        kind === 'single'
          ? f.command().archiveWorkspace({ projectId: 'proj-1', id })
          : f.command().archiveWorkspaces({ projectId: 'proj-1', ids: [id] });
      const pending = () =>
        kind === 'single' ? f.command().isArchiving : f.command().isBulkArchiving;
      const { older, newer } = await commitReactUpdate(async () => {
        const older = execute('ws-1');
        const newer = execute('ws-2');
        await f.waitForRequests(2);
        return { older, newer };
      });
      expect(pending()).toBe(true);
      await commitReactUpdate(async () => {
        f.requests[1]!.resolve(
          kind === 'single' ? { id: 'ws-2' } : { results: [{ id: 'ws-2', success: true }] }
        );
        await newer;
      });
      expect(f.queryClient.isMutating()).toBe(1);
      expect(pending()).toBe(true);
      await commitReactUpdate(async () => {
        f.requests[0]!.resolve(
          kind === 'single' ? { id: 'ws-1' } : { results: [{ id: 'ws-1', success: true }] }
        );
        await older;
      });
      expect(pending()).toBe(false);
    }
  );

  it('keeps execution pending until its post-mutation repairs settle', async () => {
    const f = fixture();
    const repairStarted = Promise.withResolvers<void>();
    const repair = Promise.withResolvers<void>();
    vi.spyOn(f.queryClient, 'invalidateQueries').mockImplementation(() => {
      repairStarted.resolve();
      return repair.promise;
    });
    const { run } = await commitReactUpdate(async () => {
      const run = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
      await f.waitForRequests();
      f.requests[0]!.resolve({ id: 'ws-1' });
      await repairStarted.promise;
      return { run };
    });
    expect(f.queryClient.isMutating()).toBe(0);
    expect(f.command().isArchiving).toBe(true);
    await commitReactUpdate(async () => {
      repair.resolve();
      await run;
    });
    expect(f.command().isArchiving).toBe(false);
  });

  it('restores only failed IDs of a multi-archive from the latest stream', async () => {
    const f = fixture();
    const run = f.command().archiveWorkspaces({ projectId: 'proj-1', ids: ['ws-1', 'ws-2'] });
    await f.waitForRequests();
    expect(f.requests[0]?.path).toBe('workspace.archiveMany');
    expect(f.requests[0]?.input).toEqual({ projectId: 'proj-1', ids: ['ws-1', 'ws-2'] });
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'latest failed' }),
    });
    expect(f.rows()).toEqual([]);
    f.requests[0]!.resolve({
      results: [
        {
          id: 'ws-1',
          success: false,
          error: 'Git locked',
          code: 'CONFLICT',
          applicationErrorKind: 'GIT_INDEX_LOCKED',
        },
        { id: 'ws-2', success: true },
      ],
    });
    const outcomes = await run;
    expect(outcomes).toEqual([
      {
        id: 'ws-1',
        success: false,
        error: {
          data: { code: 'CONFLICT', applicationErrorKind: 'GIT_INDEX_LOCKED' },
          message: 'Git locked',
        },
      },
      { id: 'ws-2', success: true },
    ]);
    expect(f.rows().map((row) => [row.id, row.name])).toEqual([['ws-1', 'latest failed']]);
  });

  it('reports a requested workspace the server returned no result for as failed', async () => {
    const f = fixture();
    const run = f.command().archiveWorkspaces({ projectId: 'proj-1', ids: ['ws-1', 'ws-2'] });
    await f.waitForRequests();
    f.requests[0]!.resolve({
      results: [
        { id: 'ws-2', success: true },
        { id: 'not-requested', success: true },
      ],
    });
    await expect(run).resolves.toEqual([
      { id: 'ws-1', success: false, error: expect.any(Error) },
      { id: 'ws-2', success: true },
    ]);
    expect(f.rows().map((row) => row.id)).toEqual(['ws-1']);
  });

  it('splits a large selection into requests of the maximum size', async () => {
    const f = fixture();
    const ids = Array.from({ length: ARCHIVE_MANY_MAX_IDS + 1 }, (_, index) => `ws-${index + 1}`);
    const run = f.command().archiveWorkspaces({ projectId: 'proj-1', ids });
    await f.waitForRequests();
    expect(f.requests[0]?.input).toEqual({
      projectId: 'proj-1',
      ids: ids.slice(0, ARCHIVE_MANY_MAX_IDS),
    });
    f.requests[0]!.reject(new Error('first chunk failed'));
    await f.waitForRequests(2);
    expect(f.requests[1]?.input).toEqual({
      projectId: 'proj-1',
      ids: ids.slice(ARCHIVE_MANY_MAX_IDS),
    });
    f.requests[1]!.resolve({ results: [{ id: ids.at(-1), success: true }] });
    const outcomes = await run;
    expect(outcomes).toHaveLength(ids.length);
    expect(outcomes.filter((outcome) => outcome.success).map((outcome) => outcome.id)).toEqual([
      ids.at(-1),
    ]);
    expect(outcomes[0]).toEqual({
      id: 'ws-1',
      success: false,
      error: expect.objectContaining({ message: 'first chunk failed' }),
    });
  });

  it('captures the requested IDs before cancellation or transport yields', async () => {
    const f = fixture();
    const ids = ['ws-1'];
    const run = f.command().archiveWorkspaces({ projectId: 'proj-1', ids });
    ids.push('ws-2');
    await f.waitForRequests();
    expect(f.requests[0]?.input).toEqual({ projectId: 'proj-1', ids: ['ws-1'] });
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    f.requests[0]!.resolve({ results: [{ id: 'ws-1', success: true }] });
    await expect(run).resolves.toEqual([{ id: 'ws-1', success: true }]);
  });

  it('returns success when list and detail repair reject', async () => {
    const f = fixture();
    vi.spyOn(f.queryClient, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    const run = f
      .command()
      .archiveWorkspace({ projectId: 'proj-1', id: 'ws-1', removeGitIndexLock: true });
    await f.waitForRequests();
    expect(f.requests[0]?.input).toEqual({ id: 'ws-1', removeGitIndexLock: true });
    f.requests[0]!.resolve({ id: 'ws-1' });
    await expect(run).resolves.toEqual([{ id: 'ws-1', success: true }]);
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
  });

  it('keeps overlapping operations hidden through reconnect, then does not undo an accepted removal', async () => {
    const f = fixture();
    const first = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    const second = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    await f.waitForRequests(2);
    f.owner.retireConnection(f.token);
    const token = f.owner.beginConnection();
    f.owner.apply(token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry(), entry({ workspaceId: 'ws-2' })],
    });
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    f.requests[0]!.reject(new Error('first failed'));
    await first;
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    f.owner.apply(token, { type: 'snapshot_removed', workspaceId: 'ws-1' });
    f.requests[1]!.reject(new Error('second failed'));
    await second;
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
  });

  it.each(['stream', 'fallback HTTP'])(
    'does not restore overlap success after a later accepted %s base',
    async (source) => {
      const f = fixture();
      const first = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
      const second = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
      await f.waitForRequests(2);
      f.requests[0]!.resolve({ id: 'ws-1' });
      await first;
      if (source === 'stream') {
        f.owner.apply(f.token, {
          type: 'snapshot_changed',
          workspaceId: 'ws-1',
          entry: entry({ name: 'late accepted' }),
        });
      } else {
        f.owner.retireConnection(f.token);
        await f.queryClient.fetchQuery({
          ...projectWorkspaceQueryOptions(f.queryClient, 'proj-1', async () => ({
            workspaces: [projectSnapshotToWorkspace(entry({ name: 'late accepted' }))],
            reviewCount: 0,
          })),
          staleTime: 0,
        });
      }
      expect(f.rows().map((row) => row.id)).not.toContain('ws-1');
      f.requests[1]!.reject(new Error('remaining archive failed'));
      await second;
      expect(f.rows().map((row) => row.id)).not.toContain('ws-1');
    }
  );

  it('cancels an in-flight HTTP request before hiding the row, so query cancellation cannot resurrect it', async () => {
    const f = fixture();
    const fetch = f.queryClient
      .fetchQuery({
        queryKey: f.owner.queryKey,
        queryFn: ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          ),
        staleTime: 0,
      })
      .catch(() => undefined);
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'accepted during HTTP' }),
    });
    const run = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    await f.waitForRequests();
    await fetch;
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    f.requests[0]!.reject(new Error('archive failed'));
    await run;
    expect(f.rows()[0]?.name).toBe('accepted during HTTP');
  });
});

describe('workspace detail archive caller', () => {
  it('navigates and invokes success after archive even when follow-up refresh fails', async () => {
    const f = fixture('route');
    const completed = Promise.withResolvers<void>();
    const success = vi.fn(() => completed.resolve());
    const error = vi.fn();
    vi.spyOn(f.queryClient, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    await f.startRouteArchive({ id: 'ws-1' }, { onSuccess: success, onError: error });
    // Success navigation unmounts the detail route, so check IDE state while it is live.
    await f.availabilityRendered;
    expect(f.route().availableIdes).toEqual([{ id: 'code', name: 'VS Code' }]);
    expect(f.route().preferredIde).toBe('code');
    await commitReactUpdate(async () => {
      f.requests[0]!.resolve({ id: 'ws-1' });
      await completed.promise;
    });
    expect(success).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(f.location()).toBe('/projects/project/workspaces');
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
  });

  it.each(['ordinary', 'locked'])(
    'retains departed-route %s failure feedback without stale callbacks or lock dialogs',
    async (kind) => {
      const f = fixture('route');
      const onError = vi.fn();
      await f.startRouteArchive({ id: 'ws-1' }, { onError });
      f.render('ws-2');
      const failure =
        kind === 'ordinary'
          ? new Error('Archive failed after departure')
          : TRPCClientError.from({
              error: {
                message: 'Git locked',
                code: -32_603,
                data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
              },
            });
      await commitReactUpdate(() => f.requests[0]!.reject(failure));
      expect(f.queryClient.isMutating()).toBe(0);
      expect(f.route().archiveWorkspace.isPending).toBe(false);
      if (kind === 'ordinary') {
        expect(toast.error).toHaveBeenCalledExactlyOnceWith('Archive failed after departure');
      } else {
        expect(toast.error).not.toHaveBeenCalled();
      }
      expect(onError).not.toHaveBeenCalled();
      expect(f.locked).not.toHaveBeenCalled();
      expect(f.location()).toBe('/detail');
    }
  );

  it('retains the pre-existing silent availability fallback and mutation-only IDE error feedback', async () => {
    const f = fixture('route', true);
    await f.availabilityFailed;
    expect(f.queryClient.getQueryState(ideAvailabilityKey)?.status).toBe('error');
    await commitReactUpdate(() => f.render());
    expect(f.route().availableIdes).toEqual([]);
    expect(f.route().preferredIde).toBe('cursor');
    expect(toast.error).not.toHaveBeenCalled();
    const errorShown = Promise.withResolvers<void>();
    vi.mocked(toast.error).mockImplementationOnce(() => {
      errorShown.resolve();
      return 0;
    });
    f.route().openInIde.mutate({ id: 'ws-1' });
    await f.waitForRequests();
    await commitReactUpdate(async () => {
      f.requests[0]!.reject(new Error('IDE launch failed'));
      await errorShown.promise;
    });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('IDE launch failed');
  });

  it('offers route lock recovery after restoring the failed row from the latest accepted base', async () => {
    const f = fixture('route');
    const failed = Promise.withResolvers<void>();
    const error = vi.fn(() => failed.resolve());
    await f.startRouteArchive({ id: 'ws-1' }, { onError: error });
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'latest failed route' }),
    });
    const locked = TRPCClientError.from({
      error: {
        message: 'Git locked',
        code: -32_603,
        data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
      },
    });
    await commitReactUpdate(async () => {
      f.requests[0]!.reject(locked);
      await failed.promise;
    });
    expect(f.locked).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(locked);
    expect(f.location()).toBe('/detail');
    expect(f.rows()[0]?.name).toBe('latest failed route');
  });

  it('stays on detail while its own archive is pending so a lock failure opens recovery', async () => {
    const f = fixture('route');
    const failed = Promise.withResolvers<void>();
    const error = vi.fn(() => failed.resolve());
    await f.startRouteArchive({ id: 'ws-1' }, { onError: error });
    expect(f.route().archiveWorkspace.isPending).toBe(true);
    // The server persists and broadcasts ARCHIVING before doing the archive work.
    await commitReactUpdate(() => f.render('ws-1', 'ARCHIVING'));
    expect(f.location()).toBe('/detail');
    // The server rolls the status back before rejecting with the lock error.
    f.render('ws-1', 'READY');
    const locked = TRPCClientError.from({
      error: {
        message: 'Git locked',
        code: -32_603,
        data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
      },
    });
    await commitReactUpdate(async () => {
      f.requests[0]!.reject(locked);
      await failed.promise;
    });
    expect(f.locked).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(locked);
    expect(toast.error).not.toHaveBeenCalled();
    expect(f.location()).toBe('/detail');
  });

  it('keeps lock recovery mounted when the failed archive refresh leaves ARCHIVING cached', async () => {
    const f = fixture('route');
    vi.spyOn(f.queryClient, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    const failed = Promise.withResolvers<void>();
    await f.startRouteArchive({ id: 'ws-1' }, { onError: () => failed.resolve() });
    await commitReactUpdate(() => f.render('ws-1', 'ARCHIVING'));
    await commitReactUpdate(async () => {
      f.requests[0]!.reject(
        TRPCClientError.from({
          error: {
            message: 'Git locked',
            code: -32_603,
            data: { applicationErrorKind: 'GIT_INDEX_LOCKED' },
          },
        })
      );
      await failed.promise;
    });
    expect(f.route().archiveWorkspace.isPending).toBe(false);
    expect(f.locked).toHaveBeenCalledOnce();
    expect(f.location()).toBe('/detail');
    // Once a fresh status arrives, a later archive from another surface redirects again.
    await commitReactUpdate(() => f.render('ws-1', 'READY'));
    await commitReactUpdate(() => f.render('ws-1', 'ARCHIVING'));
    expect(f.location()).toBe('/projects/project/workspaces');
  });

  it('navigates once its own pending archive succeeds while ARCHIVED is already visible', async () => {
    const f = fixture('route');
    const completed = Promise.withResolvers<void>();
    const success = vi.fn(() => completed.resolve());
    await f.startRouteArchive({ id: 'ws-1' }, { onSuccess: success });
    await commitReactUpdate(() => f.render('ws-1', 'ARCHIVED'));
    expect(f.location()).toBe('/detail');
    await commitReactUpdate(async () => {
      f.requests[0]!.resolve({ id: 'ws-1' });
      await completed.promise;
    });
    expect(success).toHaveBeenCalledOnce();
    expect(f.location()).toBe('/projects/project/workspaces');
  });

  it.each(['ARCHIVING', 'ARCHIVED'] as const)(
    'redirects when %s comes from another archive surface',
    async (status) => {
      const f = fixture('route');
      await commitReactUpdate(() => f.render('ws-1', status));
      expect(f.location()).toBe('/projects/project/workspaces');
    }
  );

  it.each(['ws-2', 'ws-1'])(
    'keeps late success in its originating cache after navigation to %s',
    async (selected) => {
      const f = fixture('route');
      const success = vi.fn();
      await f.startRouteArchive({ id: 'ws-1' }, { onSuccess: success });
      f.render('ws-2');
      if (selected === 'ws-1') {
        f.render('ws-1');
      }
      await commitReactUpdate(() => f.requests[0]!.resolve({ id: 'ws-1' }));
      expect(f.queryClient.isMutating()).toBe(0);
      expect(f.route().archiveWorkspace.isPending).toBe(false);
      expect(f.location()).toBe('/detail');
      expect(success).not.toHaveBeenCalled();
      expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    }
  );
});
