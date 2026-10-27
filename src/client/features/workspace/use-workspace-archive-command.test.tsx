// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
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
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const roots: Root[] = [];
const clients: QueryClient[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => flushSync(() => root.unmount()));
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

function CommandProbe({
  onResult,
}: {
  onResult: (command: ReturnType<typeof useWorkspaceArchiveCommand>) => void;
}) {
  onResult(useWorkspaceArchiveCommand());
  return null;
}
function RouteProbe({
  workspaceId,
  onResult,
  locked,
}: {
  workspaceId: string;
  onResult: (route: ReturnType<typeof useSessionManagement>, location: string) => void;
  locked: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation().pathname;
  const route = useSessionManagement({
    workspaceId,
    slug: 'project',
    sessions: [],
    inputRef,
    selectedDbSessionId: null,
    setSelectedDbSessionId: vi.fn(),
    selectedModel: '',
    selectedProvider: 'CLAUDE',
    onArchiveGitIndexLocked: locked,
  });
  onResult(route, location);
  return null;
}

function fixture(surface: 'command' | 'route' = 'command') {
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
  const requests: {
    path: string;
    input: unknown;
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
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
            } else {
              respond({ ides: [{ id: 'code', name: 'VS Code' }], preferredIde: 'code' });
            }
          }),
    ],
  });
  let command!: ReturnType<typeof useWorkspaceArchiveCommand>;
  let route!: ReturnType<typeof useSessionManagement>;
  let location = '';
  const locked = vi.fn();
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = (workspaceId = 'ws-1') =>
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <trpc.Provider client={client} queryClient={queryClient}>
            <MemoryRouter initialEntries={['/detail']}>
              {surface === 'command' ? (
                <CommandProbe
                  onResult={(value) => {
                    command = value;
                  }}
                />
              ) : (
                <RouteProbe
                  workspaceId={workspaceId}
                  locked={locked}
                  onResult={(value, nextLocation) => {
                    route = value;
                    location = nextLocation;
                  }}
                />
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
    render,
    command: () => command,
    route: () => route,
    location: () => location,
    locked,
    rows: () => queryClient.getQueryData<ProjectWorkspaceCache>(owner.queryKey)!.workspaces,
  };
}

describe('shared archive command with real QueryClient/tRPC mutations', () => {
  it('restores only failed bulk IDs from the latest stream while preserving the bulk endpoint', async () => {
    const f = fixture();
    const run = f
      .command()
      .archiveColumn({ projectId: 'proj-1', ids: ['ws-1', 'ws-2'], kanbanColumn: 'WAITING' });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]?.path).toBe('workspace.bulkArchive');
    expect(f.requests[0]?.input).toEqual({ projectId: 'proj-1', kanbanColumn: 'WAITING' });
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

  it('reports failures for additional workspaces selected by the bulk endpoint', async () => {
    const f = fixture();
    const run = f
      .command()
      .archiveColumn({ projectId: 'proj-1', ids: ['ws-1'], kanbanColumn: 'WAITING' });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.requests[0]!.resolve({
      results: [
        {
          id: 'server-extra',
          success: false,
          error: 'Git locked',
          code: 'CONFLICT',
          applicationErrorKind: 'GIT_INDEX_LOCKED',
        },
      ],
    });
    await expect(run).resolves.toEqual([
      { id: 'ws-1', success: true },
      {
        id: 'server-extra',
        success: false,
        error: {
          data: { code: 'CONFLICT', applicationErrorKind: 'GIT_INDEX_LOCKED' },
          message: 'Git locked',
        },
      },
    ]);
  });

  it('captures the requested IDs before cancellation or transport yields', async () => {
    const f = fixture();
    const ids = ['ws-1'];
    const run = f.command().archiveColumn({ projectId: 'proj-1', ids, kanbanColumn: 'WAITING' });
    ids.push('ws-2');
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    f.requests[0]!.resolve({ results: [] });
    await expect(run).resolves.toEqual([{ id: 'ws-1', success: true }]);
  });

  it('returns success when list/detail repair rejects, and sends lock retry only when requested', async () => {
    const f = fixture();
    vi.spyOn(f.queryClient, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    const run = f
      .command()
      .archiveWorkspace({ projectId: 'proj-1', id: 'ws-1', removeGitIndexLock: true });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]?.input).toEqual({ id: 'ws-1', removeGitIndexLock: true });
    f.requests[0]!.resolve({ id: 'ws-1' });
    await expect(run).resolves.toEqual([{ id: 'ws-1', success: true }]);
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
  });

  it('keeps overlapping operations hidden through reconnect, then does not undo an accepted removal', async () => {
    const f = fixture();
    const first = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    const second = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
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
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
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

  it('removes extra server-selected bulk successes even without an overlapping command', async () => {
    const f = fixture();
    const run = f
      .command()
      .archiveColumn({ projectId: 'proj-1', ids: ['ws-2'], kanbanColumn: 'WAITING' });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.requests[0]!.resolve({
      results: [
        { id: 'ws-1', success: true },
        { id: 'ws-2', success: true },
      ],
    });
    await run;
    expect(f.rows()).toEqual([]);
  });

  it('settles an extra server-selected bulk success against another pending command', async () => {
    const f = fixture();
    const invalidate = vi.spyOn(f.queryClient, 'invalidateQueries');
    const single = f.command().archiveWorkspace({ projectId: 'proj-1', id: 'ws-1' });
    const bulk = f
      .command()
      .archiveColumn({ projectId: 'proj-1', ids: ['ws-2'], kanbanColumn: 'WAITING' });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.requests[1]!.resolve({
      results: [
        { id: 'ws-1', success: true },
        { id: 'ws-2', success: true },
      ],
    });
    await expect(bulk).resolves.toEqual([
      { id: 'ws-2', success: true },
      { id: 'ws-1', success: true },
    ]);
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: getQueryKey(trpc.workspace.get, { id: 'ws-1' }, 'any') }),
      undefined
    );
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'late accepted bulk success' }),
    });
    f.requests[0]!.reject(new Error('single failed'));
    await single;
    expect(f.rows()).toEqual([]);
  });

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
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
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
    const success = vi.fn();
    const error = vi.fn();
    vi.spyOn(f.queryClient, 'invalidateQueries').mockRejectedValue(new Error('refresh failed'));
    f.route().archiveWorkspace.mutate({ id: 'ws-1' }, { onSuccess: success, onError: error });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.requests[0]!.resolve({ id: 'ws-1' });
    await vi.waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(error).not.toHaveBeenCalled();
    expect(f.location()).toBe('/projects/project/workspaces');
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    expect(f.route().availableIdes).toEqual([{ id: 'code', name: 'VS Code' }]);
    expect(f.route().preferredIde).toBe('code');
  });

  it('offers route lock recovery after restoring the failed row from the latest accepted base', async () => {
    const f = fixture('route');
    const error = vi.fn();
    f.route().archiveWorkspace.mutate({ id: 'ws-1' }, { onError: error });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
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
    f.requests[0]!.reject(locked);
    await vi.waitFor(() => expect(f.locked).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(locked);
    expect(f.location()).toBe('/detail');
    expect(f.rows()[0]?.name).toBe('latest failed route');
  });

  it.each(['ws-2', 'ws-1'])(
    'keeps late success in its originating cache after navigation to %s',
    async (selected) => {
      const f = fixture('route');
      const success = vi.fn();
      f.route().archiveWorkspace.mutate({ id: 'ws-1' }, { onSuccess: success });
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.render('ws-2');
      if (selected === 'ws-1') {
        f.render('ws-1');
      }
      f.requests[0]!.resolve({ id: 'ws-1' });
      await vi.waitFor(() => expect(f.queryClient.isMutating()).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.location()).toBe('/detail');
      expect(success).not.toHaveBeenCalled();
      expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    }
  );
});
