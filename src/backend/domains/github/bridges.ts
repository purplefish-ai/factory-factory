/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */

/** Kanban state capability needed by GitHub domain */
export interface GitHubKanbanBridge {
  updateCachedKanbanColumn(workspaceId: string): Promise<void>;
}
