/**
 * PR Review Monitor Service
 *
 * Watches all PRs for new review comments and triggers auto-fix sessions.
 * Runs on a 2-minute polling interval.
 */

import pLimit from 'p-limit';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { prReviewFixerService, type ReviewCommentDetails } from './pr-review-fixer.service';

const logger = createLogger('pr-review-monitor');

const PR_REVIEW_MONITOR_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_CONCURRENT_CHECKS = 5;

interface PRReviewSettings {
  autoFixEnabled: boolean;
  allowedUsers: string[];
  customPrompt: string | null;
}

class PRReviewMonitorService {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private readonly checkLimit = pLimit(MAX_CONCURRENT_CHECKS);

  /**
   * Start the PR review monitor
   */
  start(): void {
    if (this.monitorLoop) {
      return; // Already running
    }

    // Reset shutdown flag
    this.isShuttingDown = false;

    // Start the continuous monitoring loop
    this.monitorLoop = this.runContinuousLoop();

    logger.info('PR review monitor started', { intervalMs: PR_REVIEW_MONITOR_INTERVAL_MS });
  }

  /**
   * Stop the PR review monitor and wait for in-flight checks
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.monitorLoop) {
      logger.debug('Waiting for PR review monitor loop to complete');
      await this.monitorLoop;
      this.monitorLoop = null;
    }

    logger.info('PR review monitor stopped');
  }

  /**
   * Continuous loop that checks all workspaces, waits for completion, then sleeps
   */
  private async runContinuousLoop(): Promise<void> {
    while (!this.isShuttingDown) {
      try {
        await this.checkAllWorkspaces();
      } catch (err) {
        logger.error('PR review monitor check failed', err as Error);
      }

      // Wait for the interval before next check (unless shutting down)
      if (!this.isShuttingDown) {
        await this.sleep(PR_REVIEW_MONITOR_INTERVAL_MS);
      }
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check all active workspaces with PRs for new review comments
   */
  async checkAllWorkspaces(): Promise<{
    checked: number;
    newComments: number;
    triggered: number;
  }> {
    if (this.isShuttingDown) {
      return { checked: 0, newComments: 0, triggered: 0 };
    }

    // Find all active workspaces with PRs
    const workspaces = await workspaceAccessor.findWithPRsForReviewMonitoring();

    if (workspaces.length === 0) {
      return { checked: 0, newComments: 0, triggered: 0 };
    }

    // Legacy: This service is deprecated in favor of ratchet. Auto-fix is disabled.
    const settings: PRReviewSettings = {
      autoFixEnabled: false,
      allowedUsers: [],
      customPrompt: null,
    };

    if (!settings.autoFixEnabled) {
      logger.debug('PR review auto-fix is disabled, skipping check');
      return { checked: 0, newComments: 0, triggered: 0 };
    }

    logger.debug('Checking PR review comments for workspaces', {
      count: workspaces.length,
      allowedUsers: settings.allowedUsers,
    });

    // Process workspaces concurrently with rate limiting
    const results = await Promise.all(
      workspaces.map((workspace) =>
        this.checkLimit(() => this.checkWorkspaceReviewComments(workspace, settings))
      )
    );

    const newComments = results.filter((r) => r.hasNewComments).length;
    const triggered = results.filter((r) => r.triggered).length;

    if (newComments > 0 || triggered > 0) {
      logger.info('PR review monitor check completed', {
        checked: workspaces.length,
        newComments,
        triggered,
      });
    }

    return { checked: workspaces.length, newComments, triggered };
  }

  /**
   * Check a single workspace for new review comments
   */
  private async checkWorkspaceReviewComments(
    workspace: {
      id: string;
      prUrl: string;
      prNumber: number;
      prReviewLastCheckedAt: Date | null;
      prReviewLastCommentId: string | null;
    },
    settings: PRReviewSettings
  ): Promise<{ hasNewComments: boolean; triggered: boolean }> {
    if (this.isShuttingDown) {
      return { hasNewComments: false, triggered: false };
    }

    try {
      // Extract repo info from PR URL
      const prInfo = githubCLIService.extractPRInfo(workspace.prUrl);
      if (!prInfo) {
        logger.warn('Could not parse PR URL', { prUrl: workspace.prUrl });
        return { hasNewComments: false, triggered: false };
      }

      const repo = `${prInfo.owner}/${prInfo.repo}`;

      // Fetch PR details including reviews and comments
      const prDetails = await githubCLIService.getPRFullDetails(repo, workspace.prNumber);

      // Fetch line-level review comments
      const reviewComments = await githubCLIService.getReviewComments(repo, workspace.prNumber);

      // Filter by allowed users (if list is not empty)
      const filterByAllowedUsers = settings.allowedUsers.length > 0;

      // Filter reviews that request changes
      const changesRequestedReviews = prDetails.reviews.filter((review) => {
        if (review.state !== 'CHANGES_REQUESTED') {
          return false;
        }
        if (filterByAllowedUsers && !settings.allowedUsers.includes(review.author.login)) {
          return false;
        }
        return true;
      });

      // Filter comments by allowed users and timestamp (new or edited)
      const lastCheckedAt = workspace.prReviewLastCheckedAt?.getTime() ?? 0;

      const newReviewComments = reviewComments.filter((comment) => {
        // Filter by allowed users
        if (filterByAllowedUsers && !settings.allowedUsers.includes(comment.author.login)) {
          return false;
        }
        // Filter by timestamp (new or edited comments)
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        return createdTime > lastCheckedAt || updatedTime > lastCheckedAt;
      });

      // Also check regular PR comments
      const newPRComments = prDetails.comments.filter((comment) => {
        // Filter by allowed users
        if (filterByAllowedUsers && !settings.allowedUsers.includes(comment.author.login)) {
          return false;
        }
        // Filter by timestamp (new or edited comments)
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        return createdTime > lastCheckedAt || updatedTime > lastCheckedAt;
      });

      // Combine new comments
      const allNewComments = [
        ...newReviewComments.map((c) => ({
          id: c.id,
          author: c.author.login,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
          path: c.path,
          line: c.line,
        })),
        ...newPRComments.map((c) => ({
          id: typeof c.id === 'string' ? Number.parseInt(c.id, 10) : c.id,
          author: c.author.login,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
          path: undefined,
          line: undefined,
        })),
      ];

      // Check if there are new actionable comments
      const hasNewActionableComments =
        changesRequestedReviews.length > 0 || allNewComments.length > 0;

      if (!hasNewActionableComments) {
        // Update last checked timestamp even if no new comments
        await workspaceAccessor.update(workspace.id, {
          prReviewLastCheckedAt: new Date(),
        });
        return { hasNewComments: false, triggered: false };
      }

      logger.info('Found new review comments', {
        workspaceId: workspace.id,
        prNumber: workspace.prNumber,
        changesRequestedReviews: changesRequestedReviews.length,
        newComments: allNewComments.length,
      });

      // Build comment details for the fixer service
      const commentDetails: ReviewCommentDetails = {
        reviews: changesRequestedReviews.map((r) => ({
          id: r.id,
          author: r.author.login,
          state: r.state,
          body: r.body ?? '',
          submittedAt: r.submittedAt,
        })),
        comments: allNewComments,
      };

      // Trigger auto-fix
      const result = await prReviewFixerService.triggerReviewFix({
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
        prNumber: workspace.prNumber,
        commentDetails,
        customPrompt: settings.customPrompt ?? undefined,
      });

      // Update last checked timestamp and last comment ID
      const latestCommentId =
        allNewComments.length > 0 ? String(allNewComments[allNewComments.length - 1].id) : null;

      await workspaceAccessor.update(workspace.id, {
        prReviewLastCheckedAt: new Date(),
        prReviewLastCommentId: latestCommentId ?? workspace.prReviewLastCommentId,
      });

      if (result.status === 'started') {
        logger.info('PR review auto-fix session started', {
          workspaceId: workspace.id,
          sessionId: result.sessionId,
          prNumber: workspace.prNumber,
        });
        return { hasNewComments: true, triggered: true };
      }

      if (result.status === 'already_fixing') {
        logger.debug('PR review auto-fix already in progress', {
          workspaceId: workspace.id,
          sessionId: result.sessionId,
        });
        return { hasNewComments: true, triggered: false };
      }

      if (result.status === 'error') {
        logger.error('Failed to start PR review auto-fix', new Error(result.error), {
          workspaceId: workspace.id,
          prUrl: workspace.prUrl,
        });
      }

      return { hasNewComments: true, triggered: false };
    } catch (error) {
      logger.error('PR review check failed for workspace', error as Error, {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
      });
      return { hasNewComments: false, triggered: false };
    }
  }
}

export const prReviewMonitorService = new PRReviewMonitorService();
