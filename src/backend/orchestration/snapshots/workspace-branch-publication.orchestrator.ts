import type { workspaceDataService, WorkspaceSnapshotStore } from '@/backend/services/workspace';

/** Immediate accepted facts bypass observation coalescing and its wall-clock timestamp. */
export function subscribeWorkspaceBranchPublication(
  data: Pick<typeof workspaceDataService, 'subscribeAcceptedBranch'>,
  store: Pick<WorkspaceSnapshotStore, 'publishAcceptedBranch'>
): () => void {
  return data.subscribeAcceptedBranch((row) => {
    if (row.status === 'ARCHIVING' || row.status === 'ARCHIVED') {
      return;
    }
    store.publishAcceptedBranch(row.id, row.branchName, row.updatedAt.getTime());
  });
}
