import type { Workspace } from '@prisma-gen/browser';

/**
 * Creates an enriched workspace object with computed fields for optimistic cache updates.
 *
 * When creating a workspace, we immediately populate the workspace.get query cache
 * with this data so the detail page can show the workspace status (NEW/PROVISIONING)
 * without waiting for the server response.
 *
 * This must match the shape returned by the backend workspace.get endpoint.
 */
export function createOptimisticWorkspaceCacheData(workspace: Workspace) {
  return {
    ...workspace,
    sessionSummaries: [],
    agentSessions: [],
    terminalSessions: [],
    sidebarStatus: {
      activityState: 'IDLE' as const,
      ciState: 'NONE' as const,
    },
    ratchetButtonAnimated: false,
    flowPhase: 'NO_PR' as const,
    ciObservation: 'NOT_FETCHED' as const,
  };
}

type WorkspaceWithId = { id: string };

export type ProjectSummaryCacheData<TWorkspace extends WorkspaceWithId> = {
  workspaces: TWorkspace[];
  reviewCount: number;
};

export function removeWorkspaceFromProjectSummaryCache<TWorkspace extends WorkspaceWithId>(
  cache: ProjectSummaryCacheData<TWorkspace> | undefined,
  workspaceId: string
): ProjectSummaryCacheData<TWorkspace> | undefined {
  if (!cache) {
    return cache;
  }

  const workspaces = cache.workspaces.filter((workspace) => workspace.id !== workspaceId);
  if (workspaces.length === cache.workspaces.length) {
    return cache;
  }

  return { ...cache, workspaces };
}

export function removeWorkspacesFromProjectSummaryCache<TWorkspace extends WorkspaceWithId>(
  cache: ProjectSummaryCacheData<TWorkspace> | undefined,
  workspaceIds: Iterable<string>
): ProjectSummaryCacheData<TWorkspace> | undefined {
  if (!cache) {
    return cache;
  }

  const idsToRemove = new Set(workspaceIds);
  if (idsToRemove.size === 0) {
    return cache;
  }

  const workspaces = cache.workspaces.filter((workspace) => !idsToRemove.has(workspace.id));
  if (workspaces.length === cache.workspaces.length) {
    return cache;
  }

  return { ...cache, workspaces };
}
