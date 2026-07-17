import type { CIStatus, PRState, WorkspaceProviderSelection, WorkspaceStatus } from '@/shared/core';

export interface PRDiscoveryClaim {
  branchName: string;
  checkedAt: Date;
  retryCount: number;
  nextCheckAt: Date;
}

export interface PRSnapshotFields {
  prNumber: number;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
}

export interface WorkspaceProviderSelectionSnapshot {
  id: string;
  defaultSessionProvider: WorkspaceProviderSelection;
  ratchetSessionProvider: WorkspaceProviderSelection;
}

export interface WorkspaceFixerContext extends WorkspaceProviderSelectionSnapshot {
  worktreePath: string | null;
}

export interface WorkspaceStatusSnapshot {
  status: WorkspaceStatus;
  prUrl: string | null;
  prNumber: number | null;
  initCompletedAt: Date | null;
}

export interface WorkspacePRContext {
  branchName: string | null;
  prUrl: string | null;
}
