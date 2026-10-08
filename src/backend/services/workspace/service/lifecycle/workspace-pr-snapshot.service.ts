import { workspacePrAccessor } from '@/backend/services/workspace/resources/workspace-pr.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { PRDiscoveryClaim, WorkspacePRIdentity } from '@/backend/services/workspace/types';

class WorkspacePrSnapshotService {
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
    return workspaceAccessor.detachPR(target);
  }
  attachDiscoveredPRsIfClaimMatches(workspaceId: string, claim: PRDiscoveryClaim, urls: string[]) {
    return workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(workspaceId, claim, urls);
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
