import type { QueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';
import { workspaceDetailCacheOptions } from '@/client/lib/workspace-cache-reconciler';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';

/**
 * A newly created workspace, as the create endpoint returns it. Typed from the
 * router rather than the Prisma model, so fields the endpoint composes — the
 * ratchet's, which live in their own table — are part of the shape.
 */
export type CreatedWorkspace = inferRouterOutputs<AppRouter>['workspace']['create'];

/**
 * Creates an enriched workspace object with computed fields for optimistic cache updates.
 *
 * When creating a workspace, we immediately populate the workspace.get query cache
 * with this data so the detail page can show the workspace status (NEW/PROVISIONING)
 * without waiting for the server response.
 *
 * This must match the shape returned by the backend workspace.get endpoint.
 */
export function createOptimisticWorkspaceCacheData(workspace: CreatedWorkspace) {
  const summary = createOptimisticWorkspaceSummary(workspace);
  return {
    ...workspace,
    sessionSummaries: summary.sessionSummaries,
    agentSessions: [],
    terminalSessions: [],
    sidebarStatus: {
      activityState: 'IDLE' as const,
      ciState: 'NONE' as const,
    },
    // A freshly created workspace is always NEW, which the server derives as WORKING.
    kanbanColumn: summary.kanbanColumn,
    ratchetButtonAnimated: summary.ratchetButtonAnimated,
    flowPhase: summary.flowPhase,
    ciObservation: summary.ciObservation,
    statusReason: summary.statusReason,
    pendingRequestType: null,
  };
}

/** Creation returns a full persisted row, so it can seed detail before navigation. */
export function seedCreatedWorkspaceDetail(queryClient: QueryClient, workspace: CreatedWorkspace) {
  const options = workspaceDetailCacheOptions(queryClient, workspace.id);
  queryClient.getQueryCache().build(queryClient, options);
  queryClient.setQueryData(
    options.queryKey,
    (existing) => existing ?? createOptimisticWorkspaceCacheData(workspace)
  );
}

type WorkspaceWithId = { id: string };

export type ProjectWorkspaceCacheData<TWorkspace extends WorkspaceWithId> = {
  workspaces: TWorkspace[];
  reviewCount: number;
};

export function removeWorkspaceFromProjectWorkspaceCache<TWorkspace extends WorkspaceWithId>(
  cache: ProjectWorkspaceCacheData<TWorkspace> | undefined,
  workspaceId: string
): ProjectWorkspaceCacheData<TWorkspace> | undefined {
  if (!cache) {
    return cache;
  }

  const workspaces = cache.workspaces.filter((workspace) => workspace.id !== workspaceId);
  if (workspaces.length === cache.workspaces.length) {
    return cache;
  }

  return { ...cache, workspaces };
}
