import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import {
  type WorkspacePRWriteFields,
  workspacePrAccessor,
} from '@/backend/services/workspace/resources/workspace-pr.accessor';
import type { PRDiscoveryClaim, PRSnapshotFields } from '@/backend/services/workspace/types';

/**
 * A PR observation, plus the branch name a refresh may correct when the PR turns
 * out to have been opened from a different head branch.
 *
 * The branch name is the workspace's own column and everything else is the PR
 * cache, which is why `record` writes them in a transaction.
 */
type PRSnapshotUpdate = WorkspacePRWriteFields & { branchName?: string | null };

class WorkspacePrSnapshotService {
  record(workspaceId: string, data: PRSnapshotUpdate): Promise<void> {
    const { branchName, ...prFields } = data;
    if (branchName === undefined) {
      return workspacePrAccessor.write(workspaceId, prFields);
    }
    return workspaceAccessor.recordPrSnapshotWithBranchName(workspaceId, branchName, prFields);
  }

  attachDiscoveredPRIfClaimMatches(
    workspaceId: string,
    prUrl: string,
    claim: PRDiscoveryClaim,
    prUpdatedAt: Date
  ): Promise<boolean> {
    return workspacePrAccessor.attachDiscoveredPRIfClaimMatches(
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
    return workspacePrAccessor.updateSnapshotIfUrlMatches(
      workspaceId,
      prUrl,
      snapshot,
      prUpdatedAt
    );
  }

  applyPrSnapshotWithDispatchReset(
    workspaceId: string,
    observation: Parameters<typeof workspaceAccessor.applyPrSnapshotWithDispatchReset>[1]
  ) {
    return workspaceAccessor.applyPrSnapshotWithDispatchReset(workspaceId, observation);
  }

  applyCIObservationWithDispatchReset(
    workspaceId: string,
    observation: Parameters<typeof workspaceAccessor.applyCIObservationWithDispatchReset>[1]
  ) {
    return workspaceAccessor.applyCIObservationWithDispatchReset(workspaceId, observation);
  }
}

export const workspacePrSnapshotService = new WorkspacePrSnapshotService();
