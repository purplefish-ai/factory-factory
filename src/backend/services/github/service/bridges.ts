/**
 * Bridge interfaces for GitHub domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The GitHub domain never imports from other domains directly.
 */
import type { workspacePrSnapshotService } from '@/backend/services/workspace';

export interface GitHubPRDiscoveryClaim {
  githubOwner: string;
  githubRepo: string;
  branchName: string;
  checkedAt: Date;
  retryCount: number;
  nextCheckAt: Date;
}

export interface GitHubWorkspaceBridge {
  listPRs: typeof workspacePrSnapshotService.list;
  findPR: typeof workspacePrSnapshotService.find;
  attachPR: typeof workspacePrSnapshotService.attach;
  detachPR: typeof workspacePrSnapshotService.detach;
  attachDiscoveredPRsIfClaimMatches: typeof workspacePrSnapshotService.attachDiscoveredPRsIfClaimMatches;

  findPRContext(workspaceId: string): Promise<{
    branchName: string | null;
    prUrl: string | null;
  } | null>;
}
