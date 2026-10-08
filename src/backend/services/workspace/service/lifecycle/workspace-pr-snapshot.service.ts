import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import {
  type WorkspacePRWriteFields,
  workspacePrAccessor,
} from '@/backend/services/workspace/resources/workspace-pr.accessor';
import type {
  PRDiscoveryClaim,
  PRSnapshotFields,
  WorkspacePRIdentity,
} from '@/backend/services/workspace/types';

/**
 * A PR observation, plus the branch name a refresh may correct when the PR turns
 * out to have been opened from a different head branch.
 *
 * The branch name is the workspace's own column and everything else is the PR
 * cache, which is why `record` writes them in a transaction.
 */
type PRSnapshotUpdate = WorkspacePRWriteFields & { branchName?: string | null };

class WorkspacePrSnapshotService {
  acceptMonitoredObservation(
    input: Parameters<typeof workspacePrAccessor.acceptMonitoredObservation>[0]
  ) {
    return workspacePrAccessor.acceptMonitoredObservation(input);
  }
  list(workspaceId: string) {
    return workspacePrAccessor.list(workspaceId);
  }
  find(target: WorkspacePRIdentity) {
    return workspacePrAccessor.findByIdentity(target);
  }
  attach(workspaceId: string, url: string) {
    return workspacePrAccessor.attach(workspaceId, url);
  }
  detach(target: WorkspacePRIdentity) {
    return workspacePrAccessor.detach(target);
  }
  attachDiscoveredPRsIfClaimMatches(workspaceId: string, claim: PRDiscoveryClaim, urls: string[]) {
    return workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(workspaceId, claim, urls);
  }

  record(workspaceId: string, data: PRSnapshotUpdate): Promise<void> {
    const { branchName: _branchName, ...prFields } = data;
    return workspacePrAccessor.write(workspaceId, prFields);
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

  applyPrObservationWithDispatchReset(
    workspaceId: string,
    observation: Parameters<typeof workspaceAccessor.applyPrObservationWithDispatchReset>[1]
  ) {
    return workspaceAccessor.applyPrObservationWithDispatchReset(workspaceId, observation);
  }
}

export const workspacePrSnapshotService = new WorkspacePrSnapshotService();
