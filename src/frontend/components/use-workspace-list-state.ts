import { useCallback, useEffect, useMemo, useState } from 'react';

// =============================================================================
// Types
// =============================================================================

export type WorkspaceUIState = 'normal' | 'creating' | 'archiving';

export interface ServerWorkspace {
  id: string;
  name: string;
  branchName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: string | null;
  prCiStatus?: string | null;
  isWorking: boolean;
  gitStats: {
    total: number;
    additions: number;
    deletions: number;
    hasUncommitted: boolean;
  } | null;
  lastActivityAt?: string | null;
}

export interface WorkspaceListItem extends ServerWorkspace {
  uiState: WorkspaceUIState;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Creates a comparator function for sorting workspaces.
 * Uses custom order if provided, otherwise sorts alphabetically by name.
 */
function createWorkspaceComparator(customOrder: string[] | undefined) {
  return (a: ServerWorkspace, b: ServerWorkspace): number => {
    // If no custom order, sort alphabetically
    if (!customOrder || customOrder.length === 0) {
      return a.name.localeCompare(b.name);
    }

    const indexA = customOrder.indexOf(a.id);
    const indexB = customOrder.indexOf(b.id);

    // Both in custom order: sort by position
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB;
    }
    // Only A in custom order: A comes first
    if (indexA !== -1) {
      return -1;
    }
    // Only B in custom order: B comes first
    if (indexB !== -1) {
      return 1;
    }
    // Neither in custom order: sort by name
    return a.name.localeCompare(b.name);
  };
}

// =============================================================================
// Hook
// =============================================================================

interface UseWorkspaceListStateOptions {
  /** Custom order of workspace IDs. Workspaces not in this list appear at the end sorted by name. */
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
 * - Workspaces are ordered by customOrder if provided, otherwise alphabetically by name
 */
export function useWorkspaceListState(
  serverWorkspaces: ServerWorkspace[] | undefined,
  options: UseWorkspaceListStateOptions = {}
) {
  const { customOrder } = options;
  // Track workspace being created (before it has an ID)
  const [creatingWorkspace, setCreatingWorkspace] = useState<{ name: string } | null>(null);

  // Track workspace being archived (ID + cached data for display)
  const [archivingWorkspace, setArchivingWorkspace] = useState<{
    id: string;
    name: string;
    branchName?: string | null;
  } | null>(null);

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
        branchName: null,
        prUrl: null,
        prNumber: null,
        prState: null,
        prCiStatus: null,
        isWorking: false,
        gitStats: null,
        uiState: 'creating',
      });
    }

    // Add server workspaces with appropriate UI states
    if (serverWorkspaces) {
      const comparator = createWorkspaceComparator(customOrder);
      const sortedWorkspaces = [...serverWorkspaces].sort(comparator);

      for (const workspace of sortedWorkspaces) {
        const isArchiving = archivingWorkspace?.id === workspace.id;
        items.push({
          ...workspace,
          uiState: isArchiving ? 'archiving' : 'normal',
        });
      }
    }

    // If archiving workspace is no longer in server list but still in archiving state,
    // we DON'T add it back - it's been successfully archived and removed.
    // The archivingWorkspace state will be cleared after a brief delay for visual feedback.

    return items;
  }, [
    serverWorkspaces,
    creatingWorkspace,
    creatingWorkspaceInList,
    archivingWorkspace,
    customOrder,
  ]);

  // Clear creating state when workspace appears in list
  useEffect(() => {
    if (creatingWorkspace && creatingWorkspaceInList) {
      setCreatingWorkspace(null);
    }
  }, [creatingWorkspace, creatingWorkspaceInList]);

  // Check if archiving workspace has been removed from server list
  const archivingWorkspaceInList = archivingWorkspace
    ? serverWorkspaces?.some((w) => w.id === archivingWorkspace.id)
    : false;

  // Clear archiving state after workspace is removed and a brief delay
  useEffect(() => {
    if (!archivingWorkspace || archivingWorkspaceInList) {
      return;
    }
    // Small delay for visual feedback before clearing
    const timer = setTimeout(() => {
      setArchivingWorkspace(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [archivingWorkspace, archivingWorkspaceInList]);

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
        setArchivingWorkspace({
          id: workspace.id,
          name: workspace.name,
          branchName: workspace.branchName,
        });
      }
    },
    [serverWorkspaces]
  );

  const cancelArchiving = useCallback(
    (id?: string) => {
      if (!archivingWorkspace) {
        return;
      }
      if (!id || archivingWorkspace.id === id) {
        setArchivingWorkspace(null);
      }
    },
    [archivingWorkspace]
  );

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
