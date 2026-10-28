import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type WorkspaceDetail,
  projectSnapshotToWorkspace,
} from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import { createWorkspaceDetailTransitionScope } from '@/client/lib/workspace-detail-snapshot-transitions';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  makeWorkspaceSnapshotEntry as entry,
  makeCompleteWorkspaceSnapshotEntry as complete,
} from '@/test-utils/workspace-snapshot';

const key = (id = 'ws-1') => getQueryKey(trpc.workspace.get, { id }, 'query');
const row = (overrides: Partial<WorkspaceDetail> = {}) =>
  unsafeCoerce<WorkspaceDetail>({
    ...projectSnapshotToWorkspace(entry()),
    initErrorMessage: 'HTTP-owned setup warning',
    ...overrides,
  });
const clients: QueryClient[] = [];
const unsubscribes: Array<() => void> = [];
function client() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  return queryClient;
}
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) {
    unsubscribe();
  }
  for (const queryClient of clients.splice(0)) {
    queryClient.clear();
  }
  vi.restoreAllMocks();
});

describe('mount-owned snapshot detail transitions', () => {
  it('clears the exact active detail and aborts its old request before persisted refetch', async () => {
    const queryClient = client();
    queryClient.setQueryData(key(), row());
    queryClient.setQueryData(key('other'), row({ id: 'other' }));
    const requests: Array<{ signal: AbortSignal; resolve: (value: WorkspaceDetail) => void }> = [];
    const observer = new QueryObserver(queryClient, {
      queryKey: key(),
      queryFn: ({ signal }) => {
        const request = Promise.withResolvers<WorkspaceDetail>();
        requests.push({ signal, resolve: request.resolve });
        return request.promise;
      },
    });
    unsubscribes.push(observer.subscribe(() => undefined));
    const oldFetch = observer.refetch();
    const details = createWorkspaceDetailTransitionScope().forProject(queryClient, 'proj-1');
    details.remove('ws-1');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(queryClient.getQueryData(key('other'))).toMatchObject({ id: 'other', status: 'READY' });
    requests[1]!.resolve(row({ status: 'ARCHIVED' }));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED'));
    requests[0]!.resolve(row({ name: 'late old live' }));
    await oldFetch;
    expect(observer.getCurrentResult().data?.status).toBe('ARCHIVED');
  });

  it('deduplicates departures, rearms on live merge, and never creates absent detail', () => {
    const queryClient = client();
    const details = createWorkspaceDetailTransitionScope().forProject(queryClient, 'proj-1');
    queryClient.setQueryData(key(), row());
    details.remove('ws-1');
    expect(queryClient.getQueryData(key())).toBeUndefined();
    queryClient.setQueryData(key(), row({ status: 'ARCHIVED' }));
    details.remove('ws-1');
    expect(queryClient.getQueryData(key())).toMatchObject({ status: 'ARCHIVED' });
    details.mergeLive(complete({ name: 'restored' }));
    expect(queryClient.getQueryData(key())).toMatchObject({
      name: 'restored',
      status: 'READY',
      initErrorMessage: 'HTTP-owned setup warning',
    });
    details.remove('ws-1');
    expect(queryClient.getQueryData(key())).toBeUndefined();
    details.remove('absent');
    details.mergeLive(complete({ workspaceId: 'absent' }));
    expect(
      queryClient.getQueryCache().find({ queryKey: key('absent'), exact: true })
    ).toBeUndefined();
  });

  it('discovers cached live omissions and retains hidden and foreign details plus pre-list inventory', () => {
    const queryClient = client();
    const details = createWorkspaceDetailTransitionScope().forProject(queryClient, 'proj-1');
    for (const value of [
      row(),
      row({ id: 'hidden', status: 'ARCHIVED' }),
      row({ id: 'archiving', status: 'ARCHIVING' }),
      row({ id: 'foreign', projectId: 'proj-2' }),
    ]) {
      queryClient.setQueryData(key(value.id), value);
    }
    details.resetDepartures([], new Set(['previous']));
    expect(queryClient.getQueryData(key())).toBeUndefined();
    expect(queryClient.getQueryData(key('hidden'))).toMatchObject({ status: 'ARCHIVED' });
    expect(queryClient.getQueryData(key('archiving'))).toMatchObject({ status: 'ARCHIVING' });
    expect(queryClient.getQueryData(key('foreign'))).toMatchObject({ projectId: 'proj-2' });
    // The old list inventory marks even an absent query's departure.
    queryClient.setQueryData(key('previous'), row({ id: 'previous', status: 'ARCHIVED' }));
    details.remove('previous');
    expect(queryClient.getQueryData(key('previous'))).toMatchObject({ status: 'ARCHIVED' });
  });

  it('binds one scope to new clients and projects without clearing its history', () => {
    const first = client();
    const second = client();
    const scope = createWorkspaceDetailTransitionScope();
    scope.forProject(first, 'proj-1').remove('ws-1');
    second.setQueryData(key(), row({ status: 'ARCHIVED' }));
    const rebound = scope.forProject(second, 'proj-2');
    rebound.remove('ws-1');
    expect(second.getQueryData(key())).toMatchObject({ status: 'ARCHIVED' });
    rebound.mergeLive(entry({ projectId: 'proj-2', name: 'new binding' }));
    expect(second.getQueryData(key())).toMatchObject({ name: 'new binding', projectId: 'proj-2' });
    expect(first.getQueryData(key())).toBeUndefined();
    rebound.remove('ws-1');
    expect(second.getQueryData(key())).toBeUndefined();
  });

  it('gives independent scopes fresh history even on the same client and project', () => {
    const queryClient = client();
    const first = createWorkspaceDetailTransitionScope().forProject(queryClient, 'proj-1');
    const second = createWorkspaceDetailTransitionScope().forProject(queryClient, 'proj-1');
    first.remove('ws-1');
    queryClient.setQueryData(key(), row({ status: 'ARCHIVED' }));
    first.remove('ws-1');
    expect(queryClient.getQueryData(key())).toMatchObject({ status: 'ARCHIVED' });
    second.remove('ws-1');
    expect(queryClient.getQueryData(key())).toBeUndefined();
  });

  it('cancels a removal request before the live patch notification and active refetch', async () => {
    const queryClient = client();
    queryClient.setQueryData(key(), row());
    const requests: Array<{ signal: AbortSignal; resolve: (value: WorkspaceDetail) => void }> = [];
    const observer = new QueryObserver(queryClient, {
      queryKey: key(),
      queryFn: ({ signal }) => {
        const request = Promise.withResolvers<WorkspaceDetail>();
        requests.push({ signal, resolve: request.resolve });
        return request.promise;
      },
    });
    unsubscribes.push(observer.subscribe(() => undefined));
    const details = createWorkspaceDetailTransitionScope().forProject(queryClient, 'proj-1');
    details.remove('ws-1');
    queryClient.setQueryData(key(), row({ status: 'ARCHIVED' }));
    const patchObservations: boolean[] = [];
    unsubscribes.push(
      queryClient.getQueryCache().subscribe(({ query }) => {
        if ((query.state.data as WorkspaceDetail | undefined)?.name === 'restored') {
          patchObservations.push(requests[0]!.signal.aborted);
        }
      })
    );
    details.mergeLive(entry({ name: 'restored' }));
    expect(patchObservations.length).toBeGreaterThan(0);
    expect(patchObservations.every(Boolean)).toBe(true);
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(row({ name: 'persisted restored' }));
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.name).toBe('persisted restored')
    );
    requests[0]!.resolve(row({ status: 'ARCHIVING', name: 'late removal' }));
    await Promise.resolve();
    expect(observer.getCurrentResult().data?.name).toBe('persisted restored');
  });
});
