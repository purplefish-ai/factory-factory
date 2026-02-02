/**
 * CI Monitor Service
 *
 * Watches all PRs for CI failures and notifies active Claude sessions.
 * Runs on a 1-minute polling interval.
 */

import { CIStatus, SessionStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { userSettingsAccessor } from '../resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { ciFixerService } from './ci-fixer.service';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { sessionService } from './session.service';

const logger = createLogger('ci-monitor');

const CI_MONITOR_INTERVAL_MS = 1 * 60 * 1000; // 1 minute
const MAX_CONCURRENT_CHECKS = 5;
const MIN_NOTIFICATION_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes - don't spam sessions

class CIMonitorService {
  private isShuttingDown = false;
  private monitorLoop: Promise<void> | null = null;
  private readonly checkLimit = pLimit(MAX_CONCURRENT_CHECKS);

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

    logger.info('CI monitor started', { intervalMs: CI_MONITOR_INTERVAL_MS });
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
        await this.checkAllWorkspaces();
      } catch (err) {
        logger.error('CI monitor check failed', err as Error);
      }

      // Wait for the interval before next check (unless shutting down)
      if (!this.isShuttingDown) {
        await this.sleep(CI_MONITOR_INTERVAL_MS);
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

    logger.debug('Checking CI status for workspaces', { count: workspaces.length });

    // Process workspaces concurrently with rate limiting
    const results = await Promise.all(
      workspaces.map((workspace) => this.checkLimit(() => this.checkWorkspaceCI(workspace)))
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
  private async checkWorkspaceCI(workspace: {
    id: string;
    prUrl: string;
    prCiStatus: CIStatus;
    prCiFailedAt: Date | null;
    prCiLastNotifiedAt: Date | null;
  }): Promise<{ hasFailed: boolean; notified: boolean }> {
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

      // Update workspace with new CI status
      const updates: {
        prCiStatus: CIStatus;
        prCiFailedAt?: Date | null;
        prUpdatedAt: Date;
      } = {
        prCiStatus: currentStatus,
        prUpdatedAt: new Date(),
      };

      if (justFailed) {
        // CI just failed - mark the failure time
        updates.prCiFailedAt = new Date();
        logger.warn('CI failure detected', {
          workspaceId: workspace.id,
          prUrl: workspace.prUrl,
          prNumber: prResult.prNumber,
        });
      } else if (recovered) {
        // CI recovered - clear the failure time
        updates.prCiFailedAt = null;
        logger.info('CI recovered', {
          workspaceId: workspace.id,
          prUrl: workspace.prUrl,
          prNumber: prResult.prNumber,
        });

        // Notify CI fixing session that CI passed
        await ciFixerService.notifyCIPassed(workspace.id);
      }

      await workspaceAccessor.update(workspace.id, updates);

      // Notify active session if CI is currently failing
      let notified = false;
      if (currentStatus === CIStatus.FAILURE) {
        // Check if we should notify (either just failed or it's been a while since last notification)
        const shouldNotify = this.shouldNotifySession(workspace.prCiLastNotifiedAt, justFailed);

        if (shouldNotify) {
          notified = await this.notifyActiveSession(
            workspace.id,
            workspace.prUrl,
            prResult.prNumber
          );

          if (notified) {
            // Update last notification time
            await workspaceAccessor.update(workspace.id, {
              prCiLastNotifiedAt: new Date(),
            });
          }
        }

        // Trigger CI auto-fix if setting is enabled
        if (justFailed) {
          await this.triggerCIAutoFix(workspace.id, workspace.prUrl, prResult.prNumber);
        }
      }

      return { hasFailed: currentStatus === CIStatus.FAILURE, notified };
    } catch (error) {
      logger.error('CI check failed for workspace', error as Error, {
        workspaceId: workspace.id,
        prUrl: workspace.prUrl,
      });
      return { hasFailed: false, notified: false };
    }
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
    return timeSinceLastNotification >= MIN_NOTIFICATION_INTERVAL_MS;
  }

  /**
   * Trigger CI auto-fix if the setting is enabled
   */
  private async triggerCIAutoFix(
    workspaceId: string,
    prUrl: string,
    prNumber: number | undefined
  ): Promise<void> {
    try {
      // Check if auto-fix is enabled
      const settings = await userSettingsAccessor.get();
      if (!settings.autoFixCiIssues) {
        logger.debug('CI auto-fix is disabled', { workspaceId });
        return;
      }

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

      client.sendMessage(message);

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
