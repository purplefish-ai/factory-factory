import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { CIStatus, PRState } from '@/shared/core';

export interface PRDiscoveryClaim {
  branchName: string;
  checkedAt: Date;
  retryCount: number;
  nextCheckAt: Date;
}

interface PRSnapshotFields {
  prNumber: number;
  prState: PRState;
  prReviewState: string | null;
  prCiStatus: CIStatus;
}

type PRSnapshotUpdate = Pick<
  Parameters<typeof workspaceAccessor.update>[1],
  | 'prUrl'
  | 'prNumber'
  | 'prState'
  | 'prReviewState'
  | 'prCiStatus'
  | 'prUpdatedAt'
  | 'prCiFailedAt'
  | 'prCiLastNotifiedAt'
  | 'prReviewLastCheckedAt'
  | 'prReviewLastCommentId'
  | 'branchName'
>;

class WorkspacePrSnapshotService {
  record(workspaceId: string, data: Partial<PRSnapshotUpdate>) {
    return workspaceAccessor.update(workspaceId, {
      prUrl: data.prUrl,
      prNumber: data.prNumber,
      prState: data.prState,
      prReviewState: data.prReviewState,
      prCiStatus: data.prCiStatus,
      prUpdatedAt: data.prUpdatedAt,
      prCiFailedAt: data.prCiFailedAt,
      prCiLastNotifiedAt: data.prCiLastNotifiedAt,
      prReviewLastCheckedAt: data.prReviewLastCheckedAt,
      prReviewLastCommentId: data.prReviewLastCommentId,
      branchName: data.branchName,
    });
  }

  attachDiscoveredPRIfClaimMatches(
    workspaceId: string,
    prUrl: string,
    claim: PRDiscoveryClaim,
    prUpdatedAt: Date
  ): Promise<boolean> {
    return workspaceAccessor.attachDiscoveredPRIfClaimMatches(
      workspaceId,
      prUrl,
      claim,
      prUpdatedAt
    );
  }

  updatePRSnapshotIfUrlMatches(
    workspaceId: string,
    prUrl: string,
    snapshot: PRSnapshotFields,
    prUpdatedAt: Date
  ): Promise<boolean> {
    return workspaceAccessor.updatePRSnapshotIfUrlMatches(
      workspaceId,
      prUrl,
      snapshot,
      prUpdatedAt
    );
  }
}

export const workspacePrSnapshotService = new WorkspacePrSnapshotService();
