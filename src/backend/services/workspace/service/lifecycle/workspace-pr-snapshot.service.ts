import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

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
}

export const workspacePrSnapshotService = new WorkspacePrSnapshotService();
