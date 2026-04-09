import type { KanbanColumn, PRState, RatchetState, WorkspaceSidebarCiState } from '@/shared/core';

interface ArchiveWorkspaceStateLike {
  prState?: PRState | null;
  ratchetState?: RatchetState | null;
  kanbanColumn?: KanbanColumn | null;
  cachedKanbanColumn?: KanbanColumn | null;
  sidebarStatus?: {
    ciState?: WorkspaceSidebarCiState | null;
  } | null;
}

/**
 * Treat completed PRs and DONE kanban workspaces as safe-to-archive without
 * showing commit-before-archive warnings.
 */
export function isWorkspaceDoneOrMerged(
  workspace: ArchiveWorkspaceStateLike | null | undefined
): boolean {
  if (!workspace) {
    return false;
  }

  return (
    workspace.prState === 'MERGED' ||
    workspace.prState === 'CLOSED' ||
    workspace.ratchetState === 'MERGED' ||
    workspace.sidebarStatus?.ciState === 'MERGED' ||
    workspace.sidebarStatus?.ciState === 'CLOSED' ||
    workspace.kanbanColumn === 'DONE' ||
    workspace.cachedKanbanColumn === 'DONE'
  );
}
