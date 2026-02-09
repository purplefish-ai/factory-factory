/**
 * PR Review Monitor Service
 *
 * Watches all PRs for new review comments and triggers auto-fix sessions.
 * Runs on a 2-minute polling interval.
 */

import pLimit from 'p-limit';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { SERVICE_CONCURRENCY, SERVICE_INTERVAL_MS } from './constants';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { prReviewFixerService, type ReviewCommentDetails } from './pr-review-fixer.service';

const logger = createLogger('pr-review-monitor');

interface PRReviewSettings {
  autoFixEnabled: boolean;
  allowedUsers: string[];
  customPrompt: string | null;
}

class PRReviewMonitorService {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private readonly checkLimit = pLimit(SERVICE_CONCURRENCY.prReviewMonitorWorkspaceChecks);
  private backoffMultiplier = 1; // Start at 1x, increases on rate limit errors
  private readonly maxBackoffMultiplier = 4; // Max 4x delay

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

    logger.info('PR review monitor started', {
      intervalMs: SERVICE_INTERVAL_MS.prReviewMonitorPoll,
    });
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
        const result = await this.checkAllWorkspaces();
        // Reset backoff on successful check
        if (result.checked > 0 && this.backoffMultiplier > 1) {
          logger.info('PR review monitor check succeeded, resetting backoff', {
            previousMultiplier: this.backoffMultiplier,
          });
          this.backoffMultiplier = 1;
        }
      } catch (err) {
        logger.error('PR review monitor check failed', err as Error);
      }

      // Wait for the interval before next check (unless shutting down)
      if (!this.isShuttingDown) {
        const delayMs = SERVICE_INTERVAL_MS.prReviewMonitorPoll * this.backoffMultiplier;
        if (this.backoffMultiplier > 1) {
          logger.debug('Using backoff delay for next PR review monitor check', {
            baseIntervalMs: SERVICE_INTERVAL_MS.prReviewMonitorPoll,
            backoffMultiplier: this.backoffMultiplier,
            delayMs,
          });
        }
        await this.sleep(delayMs);
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
   * Handle GitHub API rate limit error and apply backoff
   */
  private handleRateLimitError(error: unknown, workspaceId: string, prUrl: string): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isRateLimitError =
      errorMessage.toLowerCase().includes('429') ||
      errorMessage.toLowerCase().includes('rate limit') ||
      errorMessage.toLowerCase().includes('throttl');

    if (isRateLimitError && this.backoffMultiplier < this.maxBackoffMultiplier) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, this.maxBackoffMultiplier);
      logger.warn('GitHub rate limit hit in PR review monitor, increasing backoff', {
        workspaceId,
        prUrl,
        newBackoffMultiplier: this.backoffMultiplier,
        nextDelayMs: SERVICE_INTERVAL_MS.prReviewMonitorPoll * this.backoffMultiplier,
      });
    } else {
      logger.error('PR review check failed for workspace', error as Error, {
        workspaceId,
        prUrl,
      });
    }
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
        allNewComments.length > 0 ? String(allNewComments[allNewComments.length - 1]?.id) : null;

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
      this.handleRateLimitError(error, workspace.id, workspace.prUrl);
      return { hasNewComments: false, triggered: false };
    }
  }
}

export const prReviewMonitorService = new PRReviewMonitorService();
