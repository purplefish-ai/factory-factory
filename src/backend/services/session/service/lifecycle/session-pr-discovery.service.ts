import { githubCLIService, prSnapshotService } from '@/backend/services/github';
import type { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService } from '@/backend/services/workspace';

type Logger = ReturnType<typeof createLogger>;

/**
 * After a session ends, check if a PR was created for the workspace's branch
 * that the interceptor may have missed. This is a fast fallback that avoids
 * waiting for the 3-minute periodic scheduler.
 */
export async function maybeDiscoverPROnSessionEnd(
  workspaceId: string,
  logger: Logger
): Promise<void> {
  try {
    const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
    if (!workspace) {
      return;
    }
    // Already associated -- nothing to do.
    if (workspace.prUrl) {
      return;
    }
    const { branchName, createdAt, project } = workspace;
    if (!(branchName && project?.githubOwner && project?.githubRepo)) {
      return;
    }
    const pr = await githubCLIService.findPRForBranch(
      project.githubOwner,
      project.githubRepo,
      branchName,
      createdAt
    );
    if (!pr) {
      return;
    }
    const result = await prSnapshotService.attachAndRefreshPR(workspaceId, pr.url);
    if (result.success) {
      logger.info('Discovered PR for workspace on session end', {
        workspaceId,
        branchName,
        prNumber: result.snapshot.prNumber,
        prUrl: pr.url,
      });
    }
  } catch (error) {
    // Fire-and-forget: log but don't surface to caller.
    logger.debug('PR discovery on session end failed', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
