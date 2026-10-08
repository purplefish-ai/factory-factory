/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */
import type { workspacePrSnapshotService } from '@/backend/services/workspace';
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

export interface GitHubPrAggregatePersistenceResult {
  applied: boolean;
  dispatchReset: boolean;
}

export interface GitHubPRSnapshotPersistenceInput extends GitHubSnapshotFields {
  prId?: string;
  expectedRevision?: number;
  title?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  prUrl?: string | null;
  prReviewLastCheckedAt?: Date | null;
  prReviewLastCommentId?: string | null;
  prHasMergeConflict?: boolean;
  prUpdatedAt: Date;
  branchName?: string;
}

/**
 * One ratchet check's observation of a PR. Carries the PR and review state as
 * well as CI because `deriveRatchetState` projects from all of them, so an
 * observation the check does not write is one no later read can derive from.
 */
export interface GitHubPrObservationPersistenceInput {
  /** The PR the observation was fetched for. Guarded, not written. */
  prId?: string;
  expectedRevision?: number;
  expectedPrUrl: string;
  expectedPrNumber: number;
  prCiStatus: CIStatus;
  prState: PRState;
  prReviewState: string | null;
  prHasMergeConflict: boolean;
  prUpdatedAt: Date;
  prCiFailedAt?: Date | null;
}

export interface GitHubWorkspaceBridge {
  listPRs: typeof workspacePrSnapshotService.list;
  findPR: typeof workspacePrSnapshotService.find;
  attachPR: typeof workspacePrSnapshotService.attach;
  detachPR: typeof workspacePrSnapshotService.detach;
  attachDiscoveredPRsIfClaimMatches: typeof workspacePrSnapshotService.attachDiscoveredPRsIfClaimMatches;

  findPRContext(workspaceId: string): Promise<{
    branchName: string | null;
    prUrl: string | null;
  } | null>;
  applyPrSnapshotWithDispatchReset(
    workspaceId: string,
    observation: GitHubPRSnapshotPersistenceInput
  ): Promise<GitHubPrAggregatePersistenceResult>;
  applyPrObservationWithDispatchReset(
    workspaceId: string,
    observation: GitHubPrObservationPersistenceInput
  ): Promise<GitHubPrAggregatePersistenceResult>;
}
