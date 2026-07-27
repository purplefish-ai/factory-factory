import { toError } from '@/backend/lib/error-utils';
import { isProcessRunning } from '@/backend/lib/process-liveness';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('reconciliation');

/** Workspace capabilities needed for reconciliation, injected at startup. */
export interface ReconciliationWorkspaceBridge {
  markFailed(workspaceId: string, reason: string): Promise<void>;
  initializeWorktree(
    workspaceId: string,
    options?: { branchName?: string; useExistingBranch?: boolean }
  ): Promise<void>;
  findNeedingWorktree(): Promise<
    Array<{
      id: string;
      status: string;
      branchName: string | null;
      initStartedAt: Date | null;
      initScriptPid: number | null;
    }>
  >;
}

export interface ReconciliationTerminalBridge {
  recoverOrphanedSessions(): Promise<number>;
}

/** Job name this service registers with the shared runner. */
const RECONCILIATION_CLEANUP_JOB = 'reconciliation-cleanup';

class ReconciliationService {
  private _workspace: ReconciliationWorkspaceBridge | null = null;
  private _terminal: ReconciliationTerminalBridge | null = null;
  /** The signal of the run currently executing; see `isShuttingDown`. */
  private runSignal: AbortSignal | null = null;
  /** Whether the service itself has been stopped, independent of any run. */
  private stopped = false;

  constructor() {
    jobRunner.register({
      name: RECONCILIATION_CLEANUP_JOB,
      intervalMs: SERVICE_INTERVAL_MS.reconciliationCleanup,
      run: async (signal) => {
        this.runSignal = signal;
        try {
          await this.runPeriodicReconciliation();
        } finally {
          // Scoped to this run; see the note in `scheduler.service.ts`.
          this.runSignal = null;
        }
      },
    });
  }

  /**
   * The service's own stopped state, or an abort on the run in flight. See the
   * equivalent in `scheduler.service.ts` for why both are needed: `cleanupOrphans`
   * is called directly at startup and must not reach Prisma after shutdown has
   * disconnected it, while the signal is what lets a run already underway stop
   * between steps.
   */
  private get isShuttingDown(): boolean {
    return this.stopped || (this.runSignal?.aborted ?? false);
  }

  configure(bridges: {
    workspace: ReconciliationWorkspaceBridge;
    terminal: ReconciliationTerminalBridge;
  }): void {
    this._workspace = bridges.workspace;
    this._terminal = bridges.terminal;
  }

  private get terminal(): ReconciliationTerminalBridge {
    if (!this._terminal) {
      throw new Error(
        'ReconciliationService: terminal bridge not configured. Call configure() first.'
      );
    }
    return this._terminal;
  }

  private get workspace(): ReconciliationWorkspaceBridge {
    if (!this._workspace) {
      throw new Error('ReconciliationService: bridges not configured. Call configure() first.');
    }
    return this._workspace;
  }

  /**
   * Main reconciliation - just ensures workspaces have worktrees
   */
  async reconcile(): Promise<void> {
    await this.reconcileWorkspaces();
  }

  /**
   * Start periodic reconciliation and orphan cleanup.
   */
  startPeriodicCleanup(): void {
    this.stopped = false;
    jobRunner.start(RECONCILIATION_CLEANUP_JOB);
  }

  /**
   * Stop periodic reconciliation and wait for any in-flight run to complete
   */
  async stopPeriodicCleanup(): Promise<void> {
    this.stopped = true;
    await jobRunner.stop(RECONCILIATION_CLEANUP_JOB);
  }

  private async runPeriodicReconciliation(): Promise<void> {
    let reconciliationError: unknown;
    let reconciliationFailed = false;

    try {
      await this.reconcile();
    } catch (error) {
      reconciliationError = error;
      reconciliationFailed = true;
    }

    try {
      await this.cleanupOrphans();
    } catch (error) {
      if (reconciliationFailed) {
        logger.error('Periodic orphan cleanup failed after reconciliation failure', toError(error));
      } else {
        throw error;
      }
    }

    if (reconciliationFailed) {
      throw reconciliationError;
    }
  }

  /**
   * Initialize workspaces that need worktrees via the state machine.
   * Uses workspace bridge initialization to ensure proper state transitions
   * (NEW -> PROVISIONING -> READY/FAILED), factory-factory.json support,
   * and startup script handling.
   *
   * For stale PROVISIONING workspaces (stuck due to server crash), marks
   * them as FAILED so users can manually retry via the UI — unless
   * `initScriptPid` is set and the referenced process is still running,
   * in which case the workspace is skipped (init is genuinely in progress).
   */
  private async reconcileWorkspaces(): Promise<void> {
    const workspacesNeedingWorktree = await this.workspace.findNeedingWorktree();

    for (const workspace of workspacesNeedingWorktree) {
      if (workspace.status === 'PROVISIONING') {
        if (workspace.initScriptPid && isProcessRunning(workspace.initScriptPid)) {
          logger.info('Skipping stale provisioning workspace with running init script', {
            workspaceId: workspace.id,
            initStartedAt: workspace.initStartedAt,
            initScriptPid: workspace.initScriptPid,
          });
          continue;
        }

        // Stale provisioning - mark as failed so user can retry
        try {
          await this.workspace.markFailed(
            workspace.id,
            'Provisioning timed out. This may indicate a server restart during initialization. Please retry.'
          );
          logger.warn('Marked stale provisioning workspace as failed', {
            workspaceId: workspace.id,
            initStartedAt: workspace.initStartedAt,
          });
        } catch (error) {
          logger.error('Failed to mark stale workspace as failed', toError(error), {
            workspaceId: workspace.id,
          });
        }
      } else {
        // NEW workspace - initialize normally
        try {
          await this.workspace.initializeWorktree(workspace.id, {
            branchName: workspace.branchName ?? undefined,
          });
          logger.info('Initialized workspace via reconciliation', {
            workspaceId: workspace.id,
          });
        } catch (error) {
          logger.error('Failed to initialize workspace', toError(error), {
            workspaceId: workspace.id,
          });
        }
      }
    }
  }

  /** Cleanup orphaned terminal processes on startup. */
  async cleanupOrphans(): Promise<void> {
    // Bail early if shutdown has started to avoid accessing prisma after disconnect
    if (this.isShuttingDown) {
      logger.debug('Skipping orphan cleanup - shutdown in progress');
      return;
    }

    // Terminal sessions are still PID-tracked and may become orphaned.
    const recoveredCount = await this.terminal.recoverOrphanedSessions();
    if (recoveredCount > 0) {
      logger.info('Marked orphaned terminal sessions as idle', {
        recoveredCount,
      });
    }
  }
}

export const reconciliationService = new ReconciliationService();
