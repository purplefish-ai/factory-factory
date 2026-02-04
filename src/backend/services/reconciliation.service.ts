import { SessionStatus } from '@prisma-gen/client';
import {
  claudeSessionAccessor,
  terminalSessionAccessor,
  workspaceAccessor,
} from '../resource_accessors/index';
import { initializeWorkspaceWorktree } from '../trpc/workspace/init.trpc';
import { createLogger } from './logger.service';
import { workspaceStateMachine } from './workspace-state-machine.service';

const logger = createLogger('reconciliation');

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class ReconciliationService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private cleanupInProgress: Promise<void> | null = null;

  /**
   * Main reconciliation - just ensures workspaces have worktrees
   */
  async reconcile(): Promise<void> {
    await this.reconcileWorkspaces();
  }

  /**
   * Start periodic orphan cleanup
   */
  startPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      return; // Already running
    }

    this.cleanupInterval = setInterval(() => {
      // Skip if shutdown has started
      if (this.isShuttingDown) {
        return;
      }
      // Track the cleanup promise so we can wait for it during shutdown
      this.cleanupInProgress = this.cleanupOrphans()
        .catch((err) => {
          logger.error('Periodic orphan cleanup failed', err as Error);
        })
        .finally(() => {
          this.cleanupInProgress = null;
        });
    }, CLEANUP_INTERVAL_MS);

    logger.info('Started periodic orphan cleanup', { intervalMs: CLEANUP_INTERVAL_MS });
  }

  /**
   * Stop periodic orphan cleanup and wait for any in-flight cleanup to complete
   */
  async stopPeriodicCleanup(): Promise<void> {
    this.isShuttingDown = true;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Wait for any in-flight cleanup to complete
    if (this.cleanupInProgress) {
      logger.debug('Waiting for in-flight cleanup to complete');
      await this.cleanupInProgress;
    }

    logger.info('Stopped periodic orphan cleanup');
  }

  /**
   * Initialize workspaces that need worktrees via the state machine.
   * Uses initializeWorkspaceWorktree to ensure proper state transitions
   * (NEW -> PROVISIONING -> READY/FAILED), factory-factory.json support,
   * and startup script handling.
   *
   * For stale PROVISIONING workspaces (stuck due to server crash), marks
   * them as FAILED so users can manually retry via the UI.
   */
  private async reconcileWorkspaces(): Promise<void> {
    const workspacesNeedingWorktree = await workspaceAccessor.findNeedingWorktree();

    for (const workspace of workspacesNeedingWorktree) {
      if (workspace.status === 'PROVISIONING') {
        // Stale provisioning - mark as failed so user can retry
        try {
          await workspaceStateMachine.markFailed(
            workspace.id,
            'Provisioning timed out. This may indicate a server restart during initialization. Please retry.'
          );
          logger.warn('Marked stale provisioning workspace as failed', {
            workspaceId: workspace.id,
            initStartedAt: workspace.initStartedAt,
          });
        } catch (error) {
          logger.error('Failed to mark stale workspace as failed', error as Error, {
            workspaceId: workspace.id,
          });
        }
      } else {
        // NEW workspace - initialize normally
        try {
          await initializeWorkspaceWorktree(workspace.id, {
            branchName: workspace.branchName ?? undefined,
          });
          logger.info('Initialized workspace via reconciliation', {
            workspaceId: workspace.id,
          });
        } catch (error) {
          logger.error('Failed to initialize workspace', error as Error, {
            workspaceId: workspace.id,
          });
        }
      }
    }
  }

  /**
   * Cleanup orphaned Claude processes on startup
   */
  async cleanupOrphans(): Promise<void> {
    // Bail early if shutdown has started to avoid accessing prisma after disconnect
    if (this.isShuttingDown) {
      logger.debug('Skipping orphan cleanup - shutdown in progress');
      return;
    }

    // Find Claude sessions that claim to be running
    const sessionsWithPid = await claudeSessionAccessor.findWithPid();

    for (const session of sessionsWithPid) {
      if (session.claudeProcessPid) {
        const isRunning = this.isProcessRunning(session.claudeProcessPid);
        if (!isRunning) {
          // Process is not actually running, update the database
          await claudeSessionAccessor.update(session.id, {
            status: SessionStatus.IDLE,
            claudeProcessPid: null,
          });
          logger.info('Marked orphaned session as idle', {
            sessionId: session.id,
          });
        }
      }
    }

    // Same for terminal sessions
    const terminalSessionsWithPid = await terminalSessionAccessor.findWithPid();

    for (const session of terminalSessionsWithPid) {
      if (session.pid) {
        const isRunning = this.isProcessRunning(session.pid);
        if (!isRunning) {
          await terminalSessionAccessor.update(session.id, {
            status: SessionStatus.IDLE,
            pid: null,
          });
          logger.info('Marked orphaned terminal session as idle', {
            sessionId: session.id,
          });
        }
      }
    }
  }

  /**
   * Check if a process is running by PID.
   * Returns true if process exists (even if we can't signal it due to permissions).
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      return true;
    } catch (error) {
      // ESRCH = no such process (not running)
      // EPERM = permission denied (process exists but we can't signal it)
      const err = error as NodeJS.ErrnoException;
      return err.code === 'EPERM';
    }
  }
}

export const reconciliationService = new ReconciliationService();
