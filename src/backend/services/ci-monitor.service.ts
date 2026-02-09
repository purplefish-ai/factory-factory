/**
 * CI Monitor Service
 *
 * Watches all PRs for CI failures and notifies active Claude sessions.
 * Runs on a 1-minute polling interval.
 */

import { CIStatus, SessionStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { ciFixerService } from './ci-fixer.service';
import { SERVICE_CONCURRENCY, SERVICE_INTERVAL_MS } from './constants';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';

const logger = createLogger('ci-monitor');

class CIMonitorService {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private readonly checkLimit = pLimit(SERVICE_CONCURRENCY.ciMonitorWorkspaceChecks);
  private backoffMultiplier = 1; // Start at 1x, increases on rate limit errors
  private readonly maxBackoffMultiplier = 4; // Max 4x delay

  /**
   * Start the CI monitor
   */
  start(): void {
    if (this.monitorLoop) {
      return; // Already running
    }

    // Reset shutdown flag
    this.isShuttingDown = false;

    // Start the continuous monitoring loop
    this.monitorLoop = this.runContinuousLoop();

    logger.info('CI monitor started', { intervalMs: SERVICE_INTERVAL_MS.ciMonitorPoll });
  }

  /**
   * Stop the CI monitor and wait for in-flight checks
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.monitorLoop) {
      logger.debug('Waiting for CI monitor loop to complete');
      await this.monitorLoop;
      this.monitorLoop = null;
    }

    logger.info('CI monitor stopped');
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
          logger.info('CI monitor check succeeded, resetting backoff', {
            previousMultiplier: this.backoffMultiplier,
          });
          this.backoffMultiplier = 1;
        }
      } catch (err) {
        logger.error('CI monitor check failed', err as Error);
      }

      // Wait for the interval before next check (unless shutting down)
      if (!this.isShuttingDown) {
        const delayMs = SERVICE_INTERVAL_MS.ciMonitorPoll * this.backoffMultiplier;
        if (this.backoffMultiplier > 1) {
          logger.debug('Using backoff delay for next CI monitor check', {
            baseIntervalMs: SERVICE_INTERVAL_MS.ciMonitorPoll,
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
      logger.warn('GitHub rate limit hit in CI monitor, increasing backoff', {
        workspaceId,
        prUrl,
        newBackoffMultiplier: this.backoffMultiplier,
        nextDelayMs: SERVICE_INTERVAL_MS.ciMonitorPoll * this.backoffMultiplier,
      });
    } else {
      logger.error('CI check failed for workspace', error as Error, {
        workspaceId,
        prUrl,
      });
    }
  }

  /**
   * Check all active workspaces with PRs for CI failures
   */
  async checkAllWorkspaces(): Promise<{ checked: number; failures: number; notified: number }> {
    if (this.isShuttingDown) {
      return { checked: 0, failures: 0, notified: 0 };
    }

    // Find all active workspaces with PRs
    const workspaces = await workspaceAccessor.findWithPRsForCIMonitoring();

    if (workspaces.length === 0) {
      return { checked: 0, failures: 0, notified: 0 };
    }

    // Legacy: This service is deprecated in favor of ratchet. Auto-fix is disabled.
    const autoFixEnabled = false;

    logger.debug('Checking CI status for workspaces', {
      count: workspaces.length,
      autoFixEnabled,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        prUrl: w.prUrl,
        prCiStatus: w.prCiStatus,
      })),
    });

    // Process workspaces concurrently with rate limiting
    const results = await Promise.all(
      workspaces.map((workspace) =>
        this.checkLimit(() => this.checkWorkspaceCI(workspace, autoFixEnabled))
      )
    );

    const failures = results.filter((r) => r.hasFailed).length;
    const notified = results.filter((r) => r.notified).length;

    if (failures > 0 || notified > 0) {
      logger.info('CI monitor check completed', {
        checked: workspaces.length,
        failures,
        notified,
      });
    }

    return { checked: workspaces.length, failures, notified };
  }

  /**
   * Check CI status for a single workspace and notify if needed
   */
  private async checkWorkspaceCI(
    workspace: {
      id: string;
      prUrl: string;
      prCiStatus: CIStatus;
      prCiFailedAt: Date | null;
      prCiLastNotifiedAt: Date | null;
    },
    autoFixEnabled: boolean
  ): Promise<{ hasFailed: boolean; notified: boolean }> {
    if (this.isShuttingDown) {
      return { hasFailed: false, notified: false };
    }

    try {
      // Fetch current PR status from GitHub
      const prResult = await githubCLIService.fetchAndComputePRState(workspace.prUrl);

      if (!prResult) {
        logger.debug('Failed to fetch PR status', { workspaceId: workspace.id });
        return { hasFailed: false, notified: false };
      }

      const previousStatus = workspace.prCiStatus;
      const currentStatus = prResult.prCiStatus;

      // Detect CI status transitions
      const justFailed = previousStatus !== CIStatus.FAILURE && currentStatus === CIStatus.FAILURE;
      const recovered = previousStatus === CIStatus.FAILURE && currentStatus === CIStatus.SUCCESS;

      logger.debug('CI status check for workspace', {
        workspaceId: workspace.id,
        previousStatus,
        currentStatus,
        justFailed,
        recovered,
        prNumber: prResult.prNumber,
      });

      // Handle status transition and update workspace
      await this.handleCIStatusTransition(
        workspace,
        currentStatus,
        justFailed,
        recovered,
        prResult.prNumber
      );

      // Handle failure notifications and auto-fix
      const notified = await this.handleCIFailure(
        workspace,
        currentStatus,
        justFailed,
        autoFixEnabled,
        prResult.prNumber
      );

      return { hasFailed: currentStatus === CIStatus.FAILURE, notified };
    } catch (error) {
      this.handleRateLimitError(error, workspace.id, workspace.prUrl);
      return { hasFailed: false, notified: false };
    }
  }

  /**
   * Handle CI status transition and update workspace
   */
  private async handleCIStatusTransition(
    workspace: { id: string; prUrl: string },
    currentStatus: CIStatus,
    justFailed: boolean,
    recovered: boolean,
    prNumber: number | undefined
  ): Promise<void> {
    const updates: {
      prCiStatus: CIStatus;
      prCiFailedAt?: Date | null;
      prUpdatedAt: Date;
    } = {
      prCiStatus: currentStatus,
      prUpdatedAt: new Date(),
    };

    if (justFailed) {
      updates.prCiFailedAt = new Date();
      logger.warn('CI failure detected', {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
        prNumber,
      });
    } else if (recovered) {
      updates.prCiFailedAt = null;
      logger.info('CI recovered', {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
        prNumber,
      });
      await ciFixerService.notifyCIPassed(workspace.id);
    }

    await workspaceAccessor.update(workspace.id, updates);
  }

  /**
   * Handle CI failure notifications and auto-fix triggering
   */
  private async handleCIFailure(
    workspace: { id: string; prUrl: string; prCiLastNotifiedAt: Date | null },
    currentStatus: CIStatus,
    justFailed: boolean,
    autoFixEnabled: boolean,
    prNumber: number | undefined
  ): Promise<boolean> {
    if (currentStatus !== CIStatus.FAILURE) {
      return false;
    }

    let notified = false;
    const shouldNotify = this.shouldNotifySession(workspace.prCiLastNotifiedAt, justFailed);

    if (shouldNotify) {
      notified = await this.notifyActiveSession(workspace.id, workspace.prUrl, prNumber);
      if (notified) {
        await workspaceAccessor.update(workspace.id, {
          prCiLastNotifiedAt: new Date(),
        });
      }
    }

    if (autoFixEnabled && justFailed) {
      await this.triggerCIAutoFix(workspace.id, workspace.prUrl, prNumber);
    }

    return notified;
  }

  /**
   * Determine if we should notify the session about CI failure
   */
  private shouldNotifySession(lastNotifiedAt: Date | null, justFailed: boolean): boolean {
    // Always notify if CI just failed
    if (justFailed) {
      return true;
    }

    // If we've never notified, notify now
    if (!lastNotifiedAt) {
      return true;
    }

    // Check if enough time has passed since last notification
    const timeSinceLastNotification = Date.now() - lastNotifiedAt.getTime();
    return timeSinceLastNotification >= SERVICE_INTERVAL_MS.ciMonitorMinNotification;
  }

  /**
   * Trigger CI auto-fix for a workspace.
   * Caller is responsible for checking if auto-fix is enabled.
   */
  private async triggerCIAutoFix(
    workspaceId: string,
    prUrl: string,
    prNumber: number | undefined
  ): Promise<void> {
    try {
      if (!prNumber) {
        logger.debug('Cannot trigger CI fix without PR number', { workspaceId });
        return;
      }

      // Trigger the CI fixer
      const result = await ciFixerService.triggerCIFix({
        workspaceId,
        prUrl,
        prNumber,
      });

      if (result.status === 'started') {
        logger.info('CI auto-fix session started', {
          workspaceId,
          sessionId: result.sessionId,
          prNumber,
        });
      } else if (result.status === 'already_fixing') {
        logger.debug('CI auto-fix already in progress', {
          workspaceId,
          sessionId: result.sessionId,
        });
      } else if (result.status === 'error') {
        logger.error('Failed to start CI auto-fix', new Error(result.error), {
          workspaceId,
          prUrl,
        });
      }
    } catch (error) {
      logger.error('Error triggering CI auto-fix', error as Error, { workspaceId });
    }
  }

  /**
   * Notify the active Claude session about CI failure
   */
  private async notifyActiveSession(
    workspaceId: string,
    prUrl: string,
    prNumber: number | undefined
  ): Promise<boolean> {
    try {
      // Find the most recent running session for this workspace
      const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
      const runningSession = sessions.find((s) => s.status === SessionStatus.RUNNING);

      if (!runningSession) {
        logger.debug('No running session to notify', { workspaceId });
        return false;
      }

      // Get the client for this session
      const client = sessionService.getClient(runningSession.id);
      if (!client) {
        logger.debug('Session has no active client', {
          workspaceId,
          sessionId: runningSession.id,
        });
        return false;
      }

      // Send notification message to the session
      const prIdentifier = prNumber ? `PR #${prNumber}` : 'PR';
      const message = `⚠️ **CI Failure Detected**

The CI checks for ${prIdentifier} have failed. Please review the failures and fix any issues.

PR: ${prUrl}

You can check the CI status and logs on GitHub to see what failed.`;

      client.sendMessage(message).catch((error) => {
        logger.warn('Failed to send CI failure notification', { workspaceId, error });
      });

      logger.info('Notified active session about CI failure', {
        workspaceId,
        sessionId: runningSession.id,
        prUrl,
        prNumber,
      });

      return true;
    } catch (error) {
      logger.error('Failed to notify active session', error as Error, {
        workspaceId,
        prUrl,
      });
      return false;
    }
  }
}

export const ciMonitorService = new CIMonitorService();
