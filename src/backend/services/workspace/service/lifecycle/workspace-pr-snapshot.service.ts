import {
  type WorkspacePRWriteFields,
  flattenWorkspacePR,
  selectActiveWorkspacePR,
  workspacePrAccessor,
} from '@/backend/services/workspace/resources/workspace-pr.accessor';
import { derivePRCollectionState } from '@/backend/services/workspace/resources/workspace-ratchet.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
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
type PRSnapshotUpdate = WorkspacePRWriteFields & {
  branchName?: string | null;
  prId?: string;
  expectedRevision?: number;
};

class WorkspacePrSnapshotService {
  projectCollection(prs: Awaited<ReturnType<typeof workspacePrAccessor.list>>, enabled: boolean) {
    const attached = prs.filter((pr) => !pr.detachedAt);
    return {
      ...flattenWorkspacePR(selectActiveWorkspacePR(attached)),
      ratchetState: derivePRCollectionState(attached, enabled),
    };
  }
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
    const { branchName: _branchName, prId, expectedRevision, ...prFields } = data;
    return workspacePrAccessor.write(workspaceId, prFields, prId, expectedRevision);
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
