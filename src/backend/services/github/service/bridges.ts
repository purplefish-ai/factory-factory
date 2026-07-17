/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */
import type { CIStatus, PRState } from '@/shared/core';

/** Kanban state capability needed by GitHub domain */
export interface GitHubKanbanBridge {
  updateCachedKanbanColumn(workspaceId: string): Promise<void>;
}

export interface GitHubPRDiscoveryClaim {
  branchName: string;
  checkedAt: Date;
  retryCount: number;
  nextCheckAt: Date;
}

export interface GitHubSnapshotFields {
  prNumber: number;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
}

export interface GitHubWorkspaceSnapshotUpdate {
  prUrl?: string | null;
  prNumber?: number | null;
  prState?: PRState;
  prReviewState?: string | null;
  prCiStatus?: CIStatus;
  prUpdatedAt?: Date | null;
  prCiFailedAt?: Date | null;
  prCiLastNotifiedAt?: Date | null;
  prReviewLastCheckedAt?: Date | null;
  prReviewLastCommentId?: string | null;
  branchName?: string;
}

export interface GitHubWorkspaceBridge {
  findPRContext(workspaceId: string): Promise<{
    branchName: string | null;
    prUrl: string | null;
  } | null>;
  recordSnapshot(workspaceId: string, data: GitHubWorkspaceSnapshotUpdate): Promise<unknown>;
  attachDiscoveredPRIfClaimMatches(
    workspaceId: string,
    prUrl: string,
    claim: GitHubPRDiscoveryClaim,
    prUpdatedAt: Date
  ): Promise<boolean>;
  updatePRSnapshotIfUrlMatches(
    workspaceId: string,
    prUrl: string,
    snapshot: GitHubSnapshotFields,
    prUpdatedAt: Date
  ): Promise<boolean>;
}
