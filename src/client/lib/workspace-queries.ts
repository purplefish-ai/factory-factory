import type { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import {
  mergeProjectSnapshotIntoWorkspaceDetail,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import { trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  type ProjectWorkspaceCache,
  projectWorkspaceQueryOptions,
  workspaceDetailCacheOptions,
  workspaceDetailQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

/**
 * The only place that builds options, fetches and writes for the
 * `workspace.get` and `workspace.listForProject` cache keys.
 *
 * React Query lets the latest fetch or observer of a key replace that key's
 * options, including the `structuralSharing` commit hook that reconciles HTTP
 * responses with the snapshot stream. A plain tRPC `useQuery`, `fetch` or
 * `setData` on one of these keys would therefore commit HTTP data without the
 * reconciler and leave it uninstalled for later refetches. Every reader here
 * installs the reconciler; `factory/query-owner` keeps callers on
 * this module (see src/client/lib/AGENTS.md).
 */

/** The parts of the vanilla tRPC client (`trpc.useUtils().client`) these reads use. */
export interface WorkspaceQueryTransport {
  workspace: {
    get: {
      query(input: { id: string }, options: { signal: AbortSignal }): Promise<WorkspaceDetail>;
    };
    listForProject: {
      query(
        input: { projectId: string },
        options: { signal: AbortSignal }
      ): Promise<ProjectWorkspaceCache>;
    };
  };
}

/** Board, sidebar, switcher and form options for one project's list. */
export function projectWorkspaceListQuery(
  queryClient: QueryClient,
  client: WorkspaceQueryTransport,
  projectId: string
) {
  return projectWorkspaceQueryOptions(queryClient, projectId, (signal) =>
    client.workspace.listForProject.query({ projectId }, { signal })
  );
}

/** Detail options for the route, right panel and any other detail reader. */
export function workspaceDetailQuery(
  queryClient: QueryClient,
  client: WorkspaceQueryTransport,
  workspaceId: string
) {
  return workspaceDetailQueryOptions(queryClient, workspaceId, (signal) =>
    client.workspace.get.query({ id: workspaceId }, { signal })
  );
}

/** Reads detail over HTTP, committing it through the reconciler. */
export function fetchWorkspaceDetail(
  queryClient: QueryClient,
  client: WorkspaceQueryTransport,
  workspaceId: string
): Promise<WorkspaceDetail> {
  return queryClient.query({
    ...workspaceDetailQuery(queryClient, client, workspaceId),
    staleTime: 0,
  });
}

/** Returns cached detail when present; otherwise fetches it like `fetchWorkspaceDetail`. */
export function ensureWorkspaceDetail(
  queryClient: QueryClient,
  client: WorkspaceQueryTransport,
  workspaceId: string
): Promise<WorkspaceDetail> {
  return queryClient.query({
    ...workspaceDetailQuery(queryClient, client, workspaceId),
    staleTime: 'static',
  });
}

/** Explicit optimistic list writes; snapshot and HTTP commits stay with the reconciler. */
export function setProjectWorkspaceList(
  queryClient: QueryClient,
  projectId: string,
  updater: (current: ProjectWorkspaceCache | undefined) => ProjectWorkspaceCache | undefined
): void {
  queryClient.setQueryData<ProjectWorkspaceCache>(
    getProjectWorkspaceCacheReconciler(queryClient, projectId).queryKey,
    updater
  );
}

/** Seeds detail without replacing a response or snapshot that already arrived. */
export function seedWorkspaceDetail(
  queryClient: QueryClient,
  workspaceId: string,
  create: () => WorkspaceDetail
): void {
  const options = workspaceDetailCacheOptions(queryClient, workspaceId);
  // Build with the reconciler's commit hook so a later fetch cannot find bare options.
  queryClient.getQueryCache().build(queryClient, options);
  queryClient.setQueryData<WorkspaceDetail>(options.queryKey, (existing) => existing ?? create());
}

/** Applies a live snapshot to cached detail; a summary never creates missing detail. */
export function mergeWorkspaceDetailSnapshot(
  queryClient: QueryClient,
  entry: WorkspaceSnapshotEntry
): void {
  queryClient.setQueryData<WorkspaceDetail>(detailFilter(entry.workspaceId).queryKey, (existing) =>
    mergeProjectSnapshotIntoWorkspaceDetail(entry, existing)
  );
}

function detailFilter(workspaceId: string) {
  return { queryKey: getQueryKey(trpc.workspace.get, { id: workspaceId }, 'query'), exact: true };
}

// Operations below only reuse installed options, so callers never need these keys.

/** Clears one detail and cancels its request; active observers refetch persisted detail. */
export function resetWorkspaceDetail(queryClient: QueryClient, workspaceId: string) {
  return queryClient.resetQueries(detailFilter(workspaceId));
}

/** Marks one detail stale and refetches it when observed. */
export function invalidateWorkspaceDetail(queryClient: QueryClient, workspaceId: string) {
  return queryClient.invalidateQueries(detailFilter(workspaceId));
}

/** Cancels one detail request synchronously; the returned promise settles later. */
export function cancelWorkspaceDetail(queryClient: QueryClient, workspaceId: string) {
  return queryClient.cancelQueries(detailFilter(workspaceId));
}

/** Refetches one detail only while something observes it. */
export function refetchActiveWorkspaceDetail(queryClient: QueryClient, workspaceId: string) {
  return queryClient.refetchQueries({ ...detailFilter(workspaceId), type: 'active' });
}

/** Every cached detail, including ones that outlive their project list. */
export function getCachedWorkspaceDetails(queryClient: QueryClient) {
  return queryClient
    .getQueriesData<WorkspaceDetail>({
      queryKey: getQueryKey(trpc.workspace.get, undefined, 'query'),
    })
    .map(([, detail]) => detail);
}

/** Cancels one project's list request synchronously; the returned promise settles later. */
export function cancelProjectWorkspaceList(queryClient: QueryClient, projectId: string) {
  return queryClient.cancelQueries({
    queryKey: getProjectWorkspaceCacheReconciler(queryClient, projectId).queryKey,
    exact: true,
  });
}
