/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */
import type { CIStatus, PRState } from '@/shared/core';

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

export interface GitHubPrAggregatePersistenceResult {
  applied: boolean;
  dispatchReset: boolean;
}

export interface GitHubPRSnapshotPersistenceInput extends GitHubSnapshotFields {
  prUrl?: string | null;
  prUpdatedAt: Date;
  branchName?: string;
}

/**
 * One ratchet check's observation of a PR. Carries the PR and review state as
 * well as CI because `deriveRatchetState` projects from all of them, so an
 * observation the check does not write is one no later read can derive from.
 */
export interface GitHubPrObservationPersistenceInput {
  prCiStatus: CIStatus;
  prState: PRState;
  prReviewState: string | null;
  prHasMergeConflict: boolean;
  prUpdatedAt: Date;
  prCiFailedAt?: Date | null;
}

export interface GitHubWorkspaceBridge {
  findPRContext(workspaceId: string): Promise<{
    branchName: string | null;
    prUrl: string | null;
  } | null>;
  recordSnapshot(workspaceId: string, data: GitHubWorkspaceSnapshotUpdate): Promise<unknown>;
  applyPrSnapshotWithDispatchReset(
    workspaceId: string,
    observation: GitHubPRSnapshotPersistenceInput
  ): Promise<GitHubPrAggregatePersistenceResult>;
  applyPrObservationWithDispatchReset(
    workspaceId: string,
    observation: GitHubPrObservationPersistenceInput
  ): Promise<GitHubPrAggregatePersistenceResult>;
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
