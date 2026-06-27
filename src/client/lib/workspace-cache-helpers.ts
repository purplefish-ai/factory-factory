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
    statusReason: {
      code: 'SETTING_UP' as const,
      label: 'Setting up workspace',
      tone: 'working' as const,
      needsUser: false,
    },
    pendingRequestType: null,
  };
}

type WorkspaceWithId = { id: string };

export type ProjectSummaryCacheData<TWorkspace extends WorkspaceWithId> = {
  workspaces: TWorkspace[];
  reviewCount: number;
};

function restoreWorkspacesByPreviousOrder<TWorkspace extends WorkspaceWithId>(
  currentWorkspaces: TWorkspace[],
  previousWorkspaces: TWorkspace[],
  workspacesToRestore: TWorkspace[]
): TWorkspace[] {
  const previousIndexById = new Map(
    previousWorkspaces.map((workspace, index) => [workspace.id, index])
  );
  const restoredWorkspaces = [...currentWorkspaces];

  for (const workspace of workspacesToRestore) {
    const previousIndex = previousIndexById.get(workspace.id) ?? Number.MAX_SAFE_INTEGER;
    const insertIndex = restoredWorkspaces.findIndex((current) => {
      const currentPreviousIndex = previousIndexById.get(current.id);
      return currentPreviousIndex !== undefined && currentPreviousIndex > previousIndex;
    });

    if (insertIndex === -1) {
      restoredWorkspaces.push(workspace);
    } else {
      restoredWorkspaces.splice(insertIndex, 0, workspace);
    }
  }

  return restoredWorkspaces;
}

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

export function restoreWorkspacesToListCache<TWorkspace extends WorkspaceWithId>(
  cache: TWorkspace[] | undefined,
  previousCache: TWorkspace[] | undefined,
  workspaceIds: Iterable<string>
): TWorkspace[] | undefined {
  if (!previousCache) {
    return cache;
  }

  const idsToRestore = new Set(workspaceIds);
  if (idsToRestore.size === 0) {
    return cache;
  }

  if (!cache) {
    return previousCache;
  }

  const currentIds = new Set(cache.map((workspace) => workspace.id));
  const workspacesToRestore = previousCache.filter(
    (workspace) => idsToRestore.has(workspace.id) && !currentIds.has(workspace.id)
  );

  if (workspacesToRestore.length === 0) {
    return cache;
  }

  return restoreWorkspacesByPreviousOrder(cache, previousCache, workspacesToRestore);
}

export function restoreWorkspacesToProjectSummaryCache<TWorkspace extends WorkspaceWithId>(
  cache: ProjectSummaryCacheData<TWorkspace> | undefined,
  previousCache: ProjectSummaryCacheData<TWorkspace> | undefined,
  workspaceIds: Iterable<string>
): ProjectSummaryCacheData<TWorkspace> | undefined {
  if (!previousCache) {
    return cache;
  }

  const idsToRestore = new Set(workspaceIds);
  if (idsToRestore.size === 0) {
    return cache;
  }

  if (!cache) {
    return previousCache;
  }

  const currentIds = new Set(cache.workspaces.map((workspace) => workspace.id));
  const workspacesToRestore = previousCache.workspaces.filter(
    (workspace) => idsToRestore.has(workspace.id) && !currentIds.has(workspace.id)
  );

  if (workspacesToRestore.length === 0) {
    return cache;
  }

  return {
    ...cache,
    workspaces: restoreWorkspacesByPreviousOrder(
      cache.workspaces,
      previousCache.workspaces,
      workspacesToRestore
    ),
  };
}
