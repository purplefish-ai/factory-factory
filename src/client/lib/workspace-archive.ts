interface ArchiveWorkspaceStateLike {
  prState?: string | null;
  kanbanColumn?: string | null;
  cachedKanbanColumn?: string | null;
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
    workspace.kanbanColumn === 'DONE' ||
    workspace.cachedKanbanColumn === 'DONE'
  );
}
