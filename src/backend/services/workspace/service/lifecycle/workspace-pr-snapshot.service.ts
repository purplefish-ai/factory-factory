import {
  projectWorkspacePRCollection,
  workspacePrAccessor,
} from '@/backend/services/workspace/resources/workspace-pr.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import type { PRDiscoveryClaim, WorkspacePRIdentity } from '@/backend/services/workspace/types';

class WorkspacePrSnapshotService {
  projectCollection(prs: Awaited<ReturnType<typeof workspacePrAccessor.list>>, enabled: boolean) {
    return projectWorkspacePRCollection(prs, enabled);
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
    return workspaceAccessor.detachPR(target);
  }
  attachDiscoveredPRsIfClaimMatches(workspaceId: string, claim: PRDiscoveryClaim, urls: string[]) {
    return workspacePrAccessor.attachDiscoveredPRsIfClaimMatches(workspaceId, claim, urls);
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
}

export const workspacePrSnapshotService = new WorkspacePrSnapshotService();
