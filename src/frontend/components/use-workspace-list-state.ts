import type {
  CIStatus,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
} from '@prisma-gen/browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';

// =============================================================================
// Types
// =============================================================================

export type WorkspaceUIState = 'normal' | 'creating' | 'archiving';

export interface ServerWorkspace {
  id: string;
  name: string;
  createdAt: string | Date;
  branchName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: PRState | null;
  prCiStatus?: CIStatus | null;
  isWorking: boolean;
  sessionSummaries?: Array<{
    sessionId: string;
    name: string | null;
    workflow: string | null;
    model: string | null;
    persistedStatus: SessionStatus;
    runtimePhase: 'loading' | 'starting' | 'running' | 'idle' | 'stopping' | 'error';
    processState: 'unknown' | 'alive' | 'stopped';
    activity: 'WORKING' | 'IDLE';
    updatedAt: string;
    lastExit: {
      code: number | null;
      timestamp: string;
      unexpected: boolean;
    } | null;
  }>;
  gitStats: {
    total: number;
    additions: number;
    deletions: number;
    hasUncommitted: boolean;
  } | null;
  lastActivityAt?: string | null;
  ratchetEnabled?: boolean;
  ratchetState?: RatchetState | null;
  ratchetButtonAnimated?: boolean;
  flowPhase?: string | null;
  ciObservation?: string | null;
  runScriptStatus?: RunScriptStatus | null;
  cachedKanbanColumn?: string | null;
  stateComputedAt?: string | null;
  sidebarStatus?: WorkspaceSidebarStatus;
  pendingRequestType?: 'plan_approval' | 'user_question' | null;
}

export interface WorkspaceListItem extends ServerWorkspace {
  uiState: WorkspaceUIState;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Creates a comparator function for sorting workspaces.
 * Uses custom order if provided, otherwise sorts by createdAt (newest first).
 * Workspaces missing from the custom order are treated as newly created and
 * are placed at the top (newest first), keeping existing order stable.
 */
function getCreatedAtMs(value: string | Date): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareByCreatedAtDesc(a: ServerWorkspace, b: ServerWorkspace): number {
  const createdDiff = getCreatedAtMs(b.createdAt) - getCreatedAtMs(a.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  const nameDiff = a.name.localeCompare(b.name);
  if (nameDiff !== 0) {
    return nameDiff;
  }
  return a.id.localeCompare(b.id);
}

export function sortWorkspaces(
  workspaces: ServerWorkspace[],
  customOrder: string[] | undefined
): ServerWorkspace[] {
  if (!customOrder || customOrder.length === 0) {
    return [...workspaces].sort(compareByCreatedAtDesc);
  }

  const indexById = new Map(customOrder.map((id, index) => [id, index]));
  const ordered: ServerWorkspace[] = [];
  const unordered: ServerWorkspace[] = [];

  for (const workspace of workspaces) {
    if (indexById.has(workspace.id)) {
      ordered.push(workspace);
    } else {
      unordered.push(workspace);
    }
  }

  ordered.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
  unordered.sort(compareByCreatedAtDesc);

  return [...unordered, ...ordered];
}

// =============================================================================
// Hook
// =============================================================================

interface UseWorkspaceListStateOptions {
  /** Custom order of workspace IDs. Workspaces not in this list appear at the top (newest first). */
  customOrder?: string[];
}

/**
 * Custom hook that manages workspace list state with optimistic updates.
 * Ensures stable list positions during create/archive operations.
 *
 * Key behaviors:
 * - Creating placeholder appears at the top of the list
 * - Archiving workspaces stay in their original position (no jumping)
 * - Automatically clears optimistic states when server data reflects changes
 * - Workspaces are ordered by customOrder if provided, otherwise by createdAt (newest first)
 * - Workspaces missing from customOrder appear at the top (newest first)
 */
export function useWorkspaceListState(
  serverWorkspaces: ServerWorkspace[] | undefined,
  options: UseWorkspaceListStateOptions = {}
) {
  const { customOrder } = options;
  // Track workspace being created (before it has an ID)
  const [creatingWorkspace, setCreatingWorkspace] = useState<{ name: string } | null>(null);

  // Track workspaces being archived (ID + cached data for display)
  const [archivingWorkspaces, setArchivingWorkspaces] = useState<
    Map<
      string,
      {
        id: string;
        name: string;
        branchName?: string | null;
      }
    >
  >(new Map());

  // Check if creating workspace has appeared in the server list
  const creatingWorkspaceInList = creatingWorkspace
    ? serverWorkspaces?.some((w) => w.name === creatingWorkspace.name)
    : false;

  // Build the unified workspace list with UI states
  const workspaceList = useMemo((): WorkspaceListItem[] => {
    const items: WorkspaceListItem[] = [];

    // Add "creating" placeholder at the top ONLY if:
    // 1. We're creating a new workspace
    // 2. The workspace hasn't appeared in the server list yet (prevents duplicates)
    if (creatingWorkspace && !creatingWorkspaceInList) {
      items.push({
        id: `creating-${creatingWorkspace.name}`,
        name: creatingWorkspace.name,
        createdAt: new Date().toISOString(),
        branchName: null,
        prUrl: null,
        prNumber: null,
        prState: null,
        prCiStatus: null,
        ratchetEnabled: false,
        isWorking: false,
        gitStats: null,
        uiState: 'creating',
      });
    }

    // Add server workspaces with appropriate UI states
    if (serverWorkspaces) {
      const sortedWorkspaces = sortWorkspaces(serverWorkspaces, customOrder);

      for (const workspace of sortedWorkspaces) {
        const isArchiving = archivingWorkspaces.has(workspace.id);
        items.push({
          ...workspace,
          uiState: isArchiving ? 'archiving' : 'normal',
        });
      }
    }

    // If archiving workspaces are no longer in server list but still in archiving state,
    // we DON'T add them back - they've been successfully archived and removed.
    // The archivingWorkspaces state will be cleared after a brief delay for visual feedback.

    return items;
  }, [
    serverWorkspaces,
    creatingWorkspace,
    creatingWorkspaceInList,
    archivingWorkspaces,
    customOrder,
  ]);

  // Clear creating state when workspace appears in list
  useEffect(() => {
    if (creatingWorkspace && creatingWorkspaceInList) {
      setCreatingWorkspace(null);
    }
  }, [creatingWorkspace, creatingWorkspaceInList]);

  // Clear archiving state after workspaces are removed and a brief delay
  useEffect(() => {
    if (archivingWorkspaces.size === 0) {
      return;
    }

    const workspacesToClear: string[] = [];
    for (const [id] of archivingWorkspaces) {
      const stillInList = serverWorkspaces?.some((w) => w.id === id);
      if (!stillInList) {
        workspacesToClear.push(id);
      }
    }

    if (workspacesToClear.length === 0) {
      return;
    }

    // Small delay for visual feedback before clearing
    const timer = setTimeout(() => {
      setArchivingWorkspaces((prev) => {
        const next = new Map(prev);
        for (const id of workspacesToClear) {
          next.delete(id);
        }
        return next;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [archivingWorkspaces, serverWorkspaces]);

  // Get existing workspace names (including creating workspace to prevent duplicates)
  const existingNames = useMemo(() => {
    const names = serverWorkspaces?.map((w) => w.name) ?? [];
    if (creatingWorkspace?.name) {
      names.push(creatingWorkspace.name);
    }
    return names;
  }, [serverWorkspaces, creatingWorkspace?.name]);

  const startCreating = useCallback((name: string) => {
    setCreatingWorkspace({ name });
  }, []);

  const cancelCreating = useCallback(() => {
    setCreatingWorkspace(null);
  }, []);

  const startArchiving = useCallback(
    (id: string) => {
      const workspace = serverWorkspaces?.find((w) => w.id === id);
      if (workspace) {
        setArchivingWorkspaces((prev) => {
          const next = new Map(prev);
          next.set(id, {
            id: workspace.id,
            name: workspace.name,
            branchName: workspace.branchName,
          });
          return next;
        });
      }
    },
    [serverWorkspaces]
  );

  const cancelArchiving = useCallback((id?: string) => {
    if (!id) {
      // If no ID provided, clear all
      setArchivingWorkspaces(new Map());
      return;
    }
    setArchivingWorkspaces((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return {
    workspaceList,
    existingNames,
    isCreating: !!creatingWorkspace,
    startCreating,
    cancelCreating,
    startArchiving,
    cancelArchiving,
  };
}
