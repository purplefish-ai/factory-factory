/**
 * Bridge interfaces for workspace domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The workspace domain never imports from other domains directly.
 */

/** Session capabilities needed by workspace domain */
export interface WorkspaceSessionBridge {
  isAnySessionWorking(sessionIds: string[]): boolean;
  getAllPendingRequests(): Map<string, { toolName: string }>;
}

/** GitHub capabilities needed by workspace domain */
export interface WorkspaceGitHubBridge {
  checkHealth(): Promise<{ isInstalled: boolean; isAuthenticated: boolean }>;
  listReviewRequests(): Promise<Array<{ reviewDecision: string | null }>>;
}

/** PR snapshot capability needed by workspace domain */
export interface WorkspacePRSnapshotBridge {
  refreshWorkspace(
    workspaceId: string,
    prUrl: string
  ): Promise<{ success: boolean; snapshot?: { prNumber: number; prState: string } }>;
}
