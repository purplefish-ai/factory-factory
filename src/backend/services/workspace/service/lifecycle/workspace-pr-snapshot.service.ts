import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { PRDiscoveryClaim, PRSnapshotFields } from '@/backend/services/workspace/types';

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
