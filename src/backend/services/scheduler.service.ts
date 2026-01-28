/**
 * Scheduler Service
 *
 * Local background job scheduler for periodic tasks.
 * Replaces Inngest for PR status sync.
 */

import pLimit from 'p-limit';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from './github-cli.service';
import { kanbanStateService } from './kanban-state.service';
import { createLogger } from './logger.service';

const logger = createLogger('scheduler');

const PR_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MINUTES = 5;
const MAX_CONCURRENT_PR_SYNCS = 5;

class SchedulerService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private syncInProgress: Promise<unknown> | null = null;
  private readonly prSyncLimit = pLimit(MAX_CONCURRENT_PR_SYNCS);

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.syncInterval) {
      return; // Already running
    }

    // Reset shutdown flag in case we're restarting
    this.isShuttingDown = false;

    this.syncInterval = setInterval(() => {
      if (this.isShuttingDown) {
        return;
      }

      this.syncInProgress = Promise.all([
        this.syncPRStatuses().catch((err) => {
          logger.error('PR sync batch failed', err as Error);
        }),
        this.discoverNewPRs().catch((err) => {
          logger.error('PR discovery batch failed', err as Error);
        }),
      ]).finally(() => {
        this.syncInProgress = null;
      });
    }, PR_SYNC_INTERVAL_MS);

    logger.info('Scheduler started', { prSyncIntervalMs: PR_SYNC_INTERVAL_MS });
  }

  /**
   * Stop the scheduler and wait for in-flight tasks
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    if (this.syncInProgress) {
      logger.debug('Waiting for in-flight PR sync to complete');
      await this.syncInProgress;
    }

    logger.info('Scheduler stopped');
  }

  /**
   * Batch sync PR status for all workspaces with stale PR data.
   * Can also be called manually to trigger an immediate sync.
   */
  async syncPRStatuses(): Promise<{ synced: number; failed: number }> {
    if (this.isShuttingDown) {
      logger.debug('Skipping PR sync - shutdown in progress');
      return { synced: 0, failed: 0 };
    }

    const workspaces = await workspaceAccessor.findNeedingPRSync(STALE_THRESHOLD_MINUTES);

    logger.info('Starting batch PR sync', { count: workspaces.length });

    if (workspaces.length === 0) {
      return { synced: 0, failed: 0 };
    }

    // Process workspaces concurrently with rate limiting
    const results = await Promise.all(
      workspaces.map((workspace) =>
        this.prSyncLimit(() => this.syncSinglePR(workspace.id, workspace.prUrl))
      )
    );

    const synced = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logger.info('Batch PR sync completed', { synced, failed });

    return { synced, failed };
  }

  /**
   * Discover PRs for workspaces that have a branch but no PR URL yet.
   * Checks GitHub to see if a PR exists for the workspace's branch.
   */
  async discoverNewPRs(): Promise<{ discovered: number; checked: number }> {
    if (this.isShuttingDown) {
      return { discovered: 0, checked: 0 };
    }

    const workspaces = await workspaceAccessor.findNeedingPRDiscovery();

    if (workspaces.length === 0) {
      return { discovered: 0, checked: 0 };
    }

    logger.info('Starting PR discovery', { count: workspaces.length });

    const results = await Promise.all(
      workspaces.map((workspace) => this.prSyncLimit(() => this.discoverPRForWorkspace(workspace)))
    );

    const discovered = results.filter((r) => r.found).length;

    logger.info('PR discovery completed', { checked: workspaces.length, discovered });

    return { discovered, checked: workspaces.length };
  }

  /**
   * Check if a PR exists for a single workspace's branch.
   */
  private async discoverPRForWorkspace(workspace: {
    id: string;
    branchName: string | null;
    project: { githubOwner: string | null; githubRepo: string | null };
  }): Promise<{ found: boolean }> {
    if (this.isShuttingDown) {
      return { found: false };
    }

    const { branchName, project } = workspace;
    if (!(branchName && project.githubOwner && project.githubRepo)) {
      return { found: false };
    }

    try {
      const pr = await githubCLIService.findPRForBranch(
        project.githubOwner,
        project.githubRepo,
        branchName
      );

      if (pr) {
        // Found a PR! Update the workspace
        const prResult = await githubCLIService.fetchAndComputePRState(pr.url);

        await workspaceAccessor.update(workspace.id, {
          prUrl: pr.url,
          prNumber: pr.number,
          prState: prResult?.prState,
          prReviewState: prResult?.prReviewState,
          prCiStatus: prResult?.prCiStatus,
          prUpdatedAt: new Date(),
        });

        await kanbanStateService.updateCachedKanbanColumn(workspace.id);

        logger.info('Discovered PR for workspace', {
          workspaceId: workspace.id,
          branchName,
          prNumber: pr.number,
          prUrl: pr.url,
        });

        return { found: true };
      }

      return { found: false };
    } catch (error) {
      logger.debug('PR discovery failed for workspace', {
        workspaceId: workspace.id,
        branchName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { found: false };
    }
  }

  /**
   * Sync PR status for a single workspace
   */
  private async syncSinglePR(
    workspaceId: string,
    prUrl: string | null
  ): Promise<{ success: boolean; reason?: string }> {
    if (this.isShuttingDown) {
      return { success: false, reason: 'shutdown' };
    }

    if (!prUrl) {
      logger.debug('Workspace has no PR URL', { workspaceId });
      return { success: false, reason: 'no_pr_url' };
    }

    try {
      // Fetch PR status from GitHub
      const prResult = await githubCLIService.fetchAndComputePRState(prUrl);

      if (!prResult) {
        logger.warn('Failed to fetch PR status', { workspaceId, prUrl });
        return { success: false, reason: 'fetch_failed' };
      }

      // Update workspace with new PR status
      await workspaceAccessor.update(workspaceId, {
        prNumber: prResult.prNumber,
        prState: prResult.prState,
        prReviewState: prResult.prReviewState,
        prCiStatus: prResult.prCiStatus,
        prUpdatedAt: new Date(),
      });

      // Recompute cached kanban column
      await kanbanStateService.updateCachedKanbanColumn(workspaceId);

      logger.debug('PR status synced', {
        workspaceId,
        prNumber: prResult.prNumber,
        prState: prResult.prState,
        prCiStatus: prResult.prCiStatus,
      });

      return { success: true };
    } catch (error) {
      logger.error('PR sync failed for workspace', error as Error, { workspaceId, prUrl });
      return { success: false, reason: 'error' };
    }
  }
}

export const schedulerService = new SchedulerService();
