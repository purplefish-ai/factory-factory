import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import { githubCLIService } from '../../services/github-cli.service';
import { kanbanStateService } from '../../services/kanban-state.service';
import { createLogger } from '../../services/logger.service';
import { inngest } from '../client';

const logger = createLogger('inngest:sync-pr-status');

/**
 * Batch sync PR status for all workspaces with PR URLs.
 * Runs every 5 minutes via cron.
 */
export const syncPRStatusBatch = inngest.createFunction(
  { id: 'sync-pr-status-batch', name: 'Sync PR Status (Batch)' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    // Get all workspaces needing PR sync
    const workspaces = await step.run('get-workspaces-needing-sync', () => {
      return workspaceAccessor.findNeedingPRSync(5); // 5 minute stale threshold
    });

    logger.info('Starting batch PR sync', { count: workspaces.length });

    if (workspaces.length === 0) {
      return { synced: 0 };
    }

    // Send individual sync events for each workspace
    // Events are processed concurrently by Inngest (rate limited by syncPRStatus concurrency config)
    const events = workspaces.map((workspace) => ({
      name: 'github.pr.sync' as const,
      data: {
        workspaceId: workspace.id,
        force: false,
      },
    }));

    await step.sendEvent('fan-out-pr-syncs', events);

    return { synced: workspaces.length };
  }
);

/**
 * Sync PR status for a single workspace.
 * Triggered by batch job or manual refresh.
 */
export const syncPRStatus = inngest.createFunction(
  {
    id: 'sync-pr-status',
    name: 'Sync PR Status',
    // Limit concurrent GitHub API calls to avoid rate limits
    concurrency: { limit: 5 },
  },
  { event: 'github.pr.sync' },
  async ({ event, step }) => {
    const { workspaceId, force } = event.data;

    // Get workspace
    const workspace = await step.run('get-workspace', () => {
      return workspaceAccessor.findById(workspaceId);
    });

    if (!workspace) {
      logger.warn('Workspace not found for PR sync', { workspaceId });
      return { success: false, reason: 'workspace_not_found' };
    }

    if (!workspace.prUrl) {
      logger.debug('Workspace has no PR URL', { workspaceId });
      return { success: false, reason: 'no_pr_url' };
    }

    // Check freshness (skip if recently updated, unless forced)
    if (!force && workspace.prUpdatedAt) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const prUpdatedAtDate = new Date(workspace.prUpdatedAt);
      if (prUpdatedAtDate > fiveMinutesAgo) {
        logger.debug('Skipping PR sync - recently updated', {
          workspaceId,
          prUpdatedAt: workspace.prUpdatedAt,
        });
        return { success: true, reason: 'skipped_fresh' };
      }
    }

    // Fetch PR status from GitHub
    // Note: workspace.prUrl is checked above, but we need to capture it in a const for the closure
    const prUrl = workspace.prUrl;
    const prResult = await step.run('fetch-pr-status', () => {
      return githubCLIService.fetchAndComputePRState(prUrl);
    });

    if (!prResult) {
      logger.warn('Failed to fetch PR status', { workspaceId, prUrl: workspace.prUrl });
      return { success: false, reason: 'fetch_failed' };
    }

    // Update workspace with new PR status
    await step.run('update-workspace', async () => {
      await workspaceAccessor.update(workspaceId, {
        prNumber: prResult.prNumber,
        prState: prResult.prState,
        prReviewState: prResult.prReviewState,
        prUpdatedAt: new Date(),
      });
    });

    // Recompute cached kanban column
    await step.run('update-kanban-column', async () => {
      await kanbanStateService.updateCachedKanbanColumn(workspaceId);
    });

    logger.info('PR status synced', {
      workspaceId,
      prNumber: prResult.prNumber,
      prState: prResult.prState,
    });

    return {
      success: true,
      prNumber: prResult.prNumber,
      prState: prResult.prState,
    };
  }
);
