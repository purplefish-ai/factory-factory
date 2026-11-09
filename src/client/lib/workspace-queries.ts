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
 * installs the reconciler (see docs/architecture/workspace-state.md).
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
  queryClient.setQueryData<WorkspaceDetail>(
    getQueryKey(trpc.workspace.get, { id: entry.workspaceId }, 'query'),
    (existing) => mergeProjectSnapshotIntoWorkspaceDetail(entry, existing)
  );
}
