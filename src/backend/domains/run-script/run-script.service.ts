import { type ChildProcess, spawn } from 'node:child_process';
import treeKill from 'tree-kill';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import { PortAllocationService } from '@/backend/services/port-allocation.service';
import { runScriptStateMachine } from './run-script-state-machine.service';

const logger = createLogger('run-script-service');

// Max output buffer size per run script (500KB)
const MAX_OUTPUT_BUFFER_SIZE = 500 * 1024;

/**
 * Service for managing run script execution from factory-factory.json
 */
export class RunScriptService {
  // Track running processes by workspace ID
  private readonly runningProcesses = new Map<string, ChildProcess>();

  // Output buffers by workspace ID (persists even after process stops)
  private readonly outputBuffers = new Map<string, string>();

  // Output listeners by workspace ID
  private readonly outputListeners = new Map<string, Set<(data: string) => void>>();

  // Track whether we're shutting down to prevent double cleanup
  private isShuttingDown = false;

  // Guard against duplicate handler registration on module reload
  private shutdownHandlersRegistered = false;

  /**
   * Start the run script for a workspace
   * @param workspaceId - Workspace ID
   * @returns Object with success status, port (if allocated), and pid
   */
  async startRunScript(workspaceId: string): Promise<{
    success: boolean;
    port?: number;
    pid?: number;
    error?: string;
  }> {
    try {
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      if (!workspace.runScriptCommand) {
        throw new Error('No run script configured for this workspace');
      }

      if (!workspace.worktreePath) {
        throw new Error('Workspace worktree not initialized');
      }

      // Verify stale processes and atomically transition to STARTING.
      // Returns null if the script is already running.
      const started = await runScriptStateMachine.start(workspaceId);
      if (!started) {
        // Re-read workspace for current pid/port after verify
        const fresh = await workspaceAccessor.findById(workspaceId);
        return {
          success: false,
          error: 'Run script is already running',
          pid: fresh?.runScriptPid ?? undefined,
          port: fresh?.runScriptPort ?? undefined,
        };
      }

      let command = workspace.runScriptCommand;
      let port: number | undefined;

      // Allocate port if command contains {port} placeholder
      if (command.includes('{port}')) {
        port = await PortAllocationService.findFreePort();
        command = FactoryConfigService.substitutePort(command, port);
        logger.info('Allocated port for run script', {
          workspaceId,
          port,
        });
      }

      // Spawn the process
      logger.info('Starting run script', {
        workspaceId,
        command,
        cwd: workspace.worktreePath,
      });

      const childProcess = spawn('bash', ['-c', command], {
        cwd: workspace.worktreePath,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const pid = childProcess.pid;
      if (!pid) {
        throw new Error('Failed to spawn run script process');
      }

      // Store process reference
      this.runningProcesses.set(workspaceId, childProcess);

      // Clear and initialize output buffer for new run
      const startMessage = `\x1b[36m[Factory Factory]\x1b[0m Starting ${command}\n\n`;
      this.outputBuffers.set(workspaceId, startMessage);

      // Register event handlers BEFORE async state transition to avoid missing events
      this.registerProcessHandlers(workspaceId, childProcess, pid);

      // Transition to RUNNING state AFTER registering all event handlers
      // This ensures we don't miss any events that fire during the async DB operation.
      return await this.transitionToRunning(workspaceId, childProcess, pid, port);
    } catch (error) {
      return this.handleStartError(workspaceId, error as Error);
    }
  }

  private registerProcessHandlers(
    workspaceId: string,
    childProcess: ChildProcess,
    pid: number
  ): void {
    // Handle process exit
    childProcess.on('exit', (code, signal) => {
      this.handleProcessExit(workspaceId, pid, code, signal);
    });

    // Capture and broadcast stdout/stderr
    const handleOutput = (data: Buffer) => {
      this.appendOutput(workspaceId, data.toString());
    };

    childProcess.stdout?.on('data', handleOutput);
    childProcess.stdout?.on('error', (error) => {
      logger.warn('Run script stdout stream error', { workspaceId, error, pid });
    });

    childProcess.stderr?.on('data', handleOutput);
    childProcess.stderr?.on('error', (error) => {
      logger.warn('Run script stderr stream error', { workspaceId, error, pid });
    });

    // Handle spawn errors
    childProcess.on('error', async (error) => {
      logger.error('Run script spawn error', error, { workspaceId, pid });
      this.runningProcesses.delete(workspaceId);
      try {
        await runScriptStateMachine.markFailed(workspaceId);
      } catch (stateError) {
        logger.warn('Failed to transition to FAILED on spawn error (likely already transitioned)', {
          workspaceId,
          error: stateError,
        });
      }
    });
  }

  private async handleProcessExit(
    workspaceId: string,
    pid: number,
    code: number | null,
    signal: string | null
  ): Promise<void> {
    logger.info('Run script exited', { workspaceId, pid, code, signal });

    this.runningProcesses.delete(workspaceId);
    this.outputListeners.delete(workspaceId);

    // Check current state:
    // - STOPPING: best-effort STOPPING -> IDLE completion (stop flow may have failed mid-cleanup)
    // - IDLE/COMPLETED/FAILED: already terminal, skip
    // - otherwise: transition to COMPLETED or FAILED based on exit code
    try {
      const ws = await workspaceAccessor.findById(workspaceId);
      const status = ws?.runScriptStatus;

      if (status === 'STOPPING') {
        try {
          await runScriptStateMachine.completeStopping(workspaceId);
        } catch (error) {
          logger.warn(
            'Failed to complete STOPPING after process exit (likely already transitioned)',
            {
              workspaceId,
              error,
            }
          );
        }
        return;
      }

      if (status === 'IDLE' || status === 'COMPLETED' || status === 'FAILED') {
        logger.debug(`Process exited while in ${status} state, skipping exit transition`, {
          workspaceId,
        });
        return;
      }

      // Normal exit from RUNNING (or STARTING if the process exits very fast)
      if (code === 0) {
        await runScriptStateMachine.markCompleted(workspaceId);
      } else {
        await runScriptStateMachine.markFailed(workspaceId);
      }
    } catch (error) {
      // Swallow state machine errors -- the state was likely already transitioned
      logger.warn('Exit handler state transition failed (likely already transitioned)', {
        workspaceId,
        error,
      });
    }
  }

  private appendOutput(workspaceId: string, output: string): void {
    const currentBuffer = this.outputBuffers.get(workspaceId) ?? '';
    let newBuffer = currentBuffer + output;

    if (newBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
      newBuffer = newBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
    }

    this.outputBuffers.set(workspaceId, newBuffer);

    const listeners = this.outputListeners.get(workspaceId);
    if (listeners) {
      for (const listener of listeners) {
        listener(output);
      }
    }
  }

  private async transitionToRunning(
    workspaceId: string,
    childProcess: ChildProcess,
    pid: number,
    port: number | undefined
  ): Promise<{ success: boolean; port?: number; pid?: number; error?: string }> {
    // If the process exits very fast, the exit handler may have already transitioned
    // STARTING -> COMPLETED/FAILED before we get here. In that case, markRunning will
    // fail because the CAS expects STARTING but finds COMPLETED/FAILED. That's fine --
    // the process lifecycle completed correctly.
    try {
      await runScriptStateMachine.markRunning(workspaceId, { pid, port });
      return { success: true, port, pid };
    } catch (markRunningError) {
      return this.handleMarkRunningRace(workspaceId, childProcess, pid, port, markRunningError);
    }
  }

  private async handleMarkRunningRace(
    workspaceId: string,
    childProcess: ChildProcess,
    pid: number,
    port: number | undefined,
    markRunningError: unknown
  ): Promise<{ success: boolean; port?: number; pid?: number; error?: string }> {
    // Check if the process already exited and the exit handler transitioned the state
    const ws = await workspaceAccessor.findById(workspaceId);
    const currentStatus = ws?.runScriptStatus;
    if (currentStatus === 'COMPLETED' || currentStatus === 'FAILED') {
      logger.info('Process exited before markRunning -- exit handler already transitioned state', {
        workspaceId,
        pid,
        currentStatus,
      });
      return { success: true, port, pid };
    }
    // Concurrent stop completed (STARTING -> STOPPING -> IDLE) while we were spawning.
    // Kill the orphaned process so it doesn't leak.
    if (currentStatus === 'IDLE' || currentStatus === 'STOPPING') {
      logger.info('Concurrent stop completed before markRunning -- killing orphaned process', {
        workspaceId,
        pid,
        currentStatus,
      });
      try {
        childProcess.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      this.runningProcesses.delete(workspaceId);
      return { success: false, error: 'Run script was stopped before it could start' };
    }
    throw markRunningError;
  }

  private async handleStartError(
    workspaceId: string,
    error: Error
  ): Promise<{ success: boolean; error?: string }> {
    logger.error('Failed to start run script', error, { workspaceId });

    // Only transition to FAILED if THIS call initiated the STARTING state
    // If the error is a state machine error (e.g., concurrent start), don't mark as FAILED
    if (error.name !== 'RunScriptStateMachineError') {
      try {
        const workspace = await workspaceAccessor.findById(workspaceId);
        if (workspace?.runScriptStatus === 'STARTING') {
          await runScriptStateMachine.markFailed(workspaceId);
        }
      } catch (stateError) {
        logger.error('Failed to transition to FAILED state', stateError as Error, {
          workspaceId,
        });
      }
    }

    return { success: false, error: error.message };
  }

  /**
   * Stop the run script for a workspace
   * @param workspaceId - Workspace ID
   * @returns Object with success status
   */
  async stopRunScript(workspaceId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      const childProcess = this.runningProcesses.get(workspaceId);
      const pid = workspace.runScriptPid;
      const status = workspace.runScriptStatus;

      // Already idle -- nothing to do
      if (status === 'IDLE') {
        return { success: true };
      }

      // STOPPING can be sticky if a previous stop flow failed mid-cleanup.
      // Try to complete it opportunistically.
      if (status === 'STOPPING') {
        await this.completeStoppingAfterStop(workspaceId);
        return { success: true };
      }

      // Terminal states: kill any orphaned process, then reset to IDLE
      if (status === 'COMPLETED' || status === 'FAILED') {
        return this.handleTerminalStateStop(workspaceId, childProcess);
      }

      // STARTING or RUNNING -- attempt STOPPING transition
      if (!(childProcess || pid)) {
        return { success: false, error: 'No run script is running' };
      }

      // Transition to STOPPING (works from both STARTING and RUNNING)
      const raced = await this.attemptBeginStopping(workspaceId);
      if (raced) {
        return { success: true };
      }

      // Run cleanup script if configured
      if (workspace.runScriptCleanupCommand && workspace.worktreePath) {
        await this.runCleanupScript(workspaceId, {
          runScriptCleanupCommand: workspace.runScriptCleanupCommand,
          worktreePath: workspace.worktreePath,
          runScriptPort: workspace.runScriptPort,
        });
      }

      // Kill the process tree
      await this.killProcessTree(workspaceId, childProcess, pid);

      // Transition to IDLE state via state machine (completes stopping)
      await this.completeStoppingAfterStop(workspaceId);

      return { success: true };
    } catch (error) {
      logger.error('Failed to stop run script', error as Error, { workspaceId });
      return { success: false, error: (error as Error).message };
    }
  }

  private async handleTerminalStateStop(
    workspaceId: string,
    childProcess: ChildProcess | undefined
  ): Promise<{ success: boolean }> {
    if (childProcess) {
      logger.warn('Killing orphaned process in terminal state', {
        workspaceId,
        pid: childProcess.pid,
      });
      try {
        childProcess.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      this.runningProcesses.delete(workspaceId);
    }
    try {
      await runScriptStateMachine.reset(workspaceId);
    } catch {
      // State may have already moved -- that's fine
    }
    return { success: true };
  }

  private async attemptBeginStopping(workspaceId: string): Promise<boolean> {
    try {
      await runScriptStateMachine.beginStopping(workspaceId);
      return false; // No race -- continue with stop flow
    } catch (error) {
      // Race: state moved to a terminal state between our read and the CAS write.
      const fresh = await workspaceAccessor.findById(workspaceId);
      const freshStatus = fresh?.runScriptStatus;
      if (
        freshStatus === 'COMPLETED' ||
        freshStatus === 'FAILED' ||
        freshStatus === 'IDLE' ||
        freshStatus === 'STOPPING'
      ) {
        logger.debug('beginStopping raced with exit handler, treating as stopped', {
          workspaceId,
          freshStatus,
        });
        return true; // Raced -- caller should return success
      }
      throw error; // Unexpected -- re-throw
    }
  }

  private async completeStoppingAfterStop(workspaceId: string): Promise<void> {
    try {
      await runScriptStateMachine.completeStopping(workspaceId);
    } catch (error) {
      // Exit handler may have raced and already completed STOPPING -> IDLE.
      const fresh = await workspaceAccessor.findById(workspaceId);
      if (fresh?.runScriptStatus === 'IDLE') {
        logger.debug('completeStopping raced with exit handler, already IDLE', {
          workspaceId,
        });
        return;
      }
      throw error;
    }
  }

  private async runCleanupScript(
    workspaceId: string,
    workspace: {
      runScriptCleanupCommand: string;
      worktreePath: string;
      runScriptPort: number | null;
    }
  ): Promise<void> {
    logger.info('Running cleanup script before stopping', {
      workspaceId,
      cleanupCommand: workspace.runScriptCleanupCommand,
    });

    try {
      const cleanupCommand = workspace.runScriptPort
        ? FactoryConfigService.substitutePort(
            workspace.runScriptCleanupCommand,
            workspace.runScriptPort
          )
        : workspace.runScriptCleanupCommand;

      const cleanupProcess = spawn('bash', ['-c', cleanupCommand], {
        cwd: workspace.worktreePath,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      cleanupProcess.stdout?.on('error', (error) => {
        logger.warn('Cleanup script stdout stream error', { workspaceId, error });
      });
      cleanupProcess.stderr?.on('error', (error) => {
        logger.warn('Cleanup script stderr stream error', { workspaceId, error });
      });

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('Cleanup script timed out, proceeding anyway', { workspaceId });
          cleanupProcess.kill('SIGTERM');
          resolve();
        }, 5000);

        cleanupProcess.on('exit', (code) => {
          clearTimeout(timeout);
          logger.info('Cleanup script completed', { workspaceId, exitCode: code });
          resolve();
        });

        cleanupProcess.on('error', (error) => {
          clearTimeout(timeout);
          logger.error('Cleanup script error', error, { workspaceId });
          resolve();
        });
      });
    } catch (error) {
      logger.error('Failed to run cleanup script', error as Error, { workspaceId });
    }
  }

  private async killProcessTree(
    workspaceId: string,
    childProcess: ChildProcess | undefined,
    pid: number | null
  ): Promise<void> {
    const targetPid = childProcess?.pid ?? pid;
    if (!targetPid) {
      return;
    }

    const source = childProcess?.pid ? 'stored process' : 'PID';
    logger.info(`Stopping run script via ${source}`, { workspaceId, pid: targetPid });

    await new Promise<void>((resolve) => {
      treeKill(targetPid, 'SIGTERM', (err) => {
        if (err) {
          const errorCode = (err as NodeJS.ErrnoException).code;
          const message = err.message;
          if (errorCode === 'ESRCH' || message.includes('No such process')) {
            logger.debug('Run script process already exited before tree-kill', {
              workspaceId,
              pid: targetPid,
              error: message,
            });
          } else {
            logger.warn('Failed to tree-kill run script process', {
              workspaceId,
              pid: targetPid,
              error: message,
            });
          }
        }
        this.runningProcesses.delete(workspaceId);
        resolve();
      });
    });
  }

  /**
   * Get the status of the run script for a workspace
   */
  async getRunScriptStatus(workspaceId: string) {
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    // Verify process status via state machine (handles stale process detection)
    const status = await runScriptStateMachine.verifyRunning(workspaceId);

    // Refetch workspace to get fresh data after potential state transition
    const freshWorkspace = await workspaceAccessor.findById(workspaceId);
    if (!freshWorkspace) {
      throw new Error('Workspace not found');
    }

    return {
      status,
      pid: freshWorkspace.runScriptPid,
      port: freshWorkspace.runScriptPort,
      startedAt: freshWorkspace.runScriptStartedAt,
      hasRunScript: !!freshWorkspace.runScriptCommand,
      runScriptCommand: freshWorkspace.runScriptCommand,
    };
  }

  /**
   * Get the output buffer for a workspace's run script
   */
  getOutputBuffer(workspaceId: string): string {
    return this.outputBuffers.get(workspaceId) ?? '';
  }

  /**
   * Subscribe to output from a workspace's run script
   * @returns Unsubscribe function
   */
  subscribeToOutput(workspaceId: string, listener: (data: string) => void): () => void {
    let listeners = this.outputListeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.outputListeners.set(workspaceId, listeners);
    }
    listeners.add(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.outputListeners.get(workspaceId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.outputListeners.delete(workspaceId);
        }
      }
    };
  }

  /**
   * Cleanup all running scripts (called on server shutdown)
   */
  async cleanup() {
    logger.info('Cleaning up all running scripts', {
      count: this.runningProcesses.size,
    });

    // Stop all running scripts using the stopRunScript method
    // This ensures cleanup scripts are run
    const workspaceIds = Array.from(this.runningProcesses.keys());
    await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        try {
          await this.stopRunScript(workspaceId);
        } catch (error) {
          logger.error('Failed to stop run script during cleanup', error as Error, {
            workspaceId,
          });
        }
      })
    );

    this.runningProcesses.clear();
  }

  /**
   * Synchronous cleanup for 'exit' event - kills processes without running cleanup scripts.
   *
   * Uses childProcess.kill() instead of tree-kill because this runs from the synchronous
   * 'exit' event handler. For proper cleanup with full tree kill, graceful shutdown via
   * SIGINT/SIGTERM handlers should be used instead (see cleanup() which calls stopRunScript).
   *
   * @internal
   */
  cleanupSync() {
    logger.info('Process exiting, killing any remaining run scripts');
    for (const [workspaceId, childProcess] of this.runningProcesses.entries()) {
      try {
        if (!childProcess.killed) {
          childProcess.kill('SIGKILL');
        }
        logger.info('Force killed run script on exit', {
          workspaceId,
          pid: childProcess.pid,
        });
      } catch {
        // Ignore errors during forced shutdown
      }
    }
    this.runningProcesses.clear();
    this.outputBuffers.clear();
    this.outputListeners.clear();
  }

  /**
   * Register process signal handlers for graceful shutdown.
   * Called once at module load time after singleton creation.
   */
  registerShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }
    this.shutdownHandlersRegistered = true;

    // Register cleanup handlers for graceful shutdown
    // These handlers allow async cleanup (unlike 'exit' which is synchronous)
    // Note: We don't call process.exit() to allow other shutdown handlers to run
    process.on('SIGINT', async () => {
      if (this.isShuttingDown) {
        return;
      }
      this.isShuttingDown = true;
      logger.info('Received SIGINT, cleaning up run scripts');
      await this.cleanup();
    });

    process.on('SIGTERM', async () => {
      if (this.isShuttingDown) {
        return;
      }
      this.isShuttingDown = true;
      logger.info('Received SIGTERM, cleaning up run scripts');
      await this.cleanup();
    });

    // Fallback synchronous cleanup for 'exit' event
    // This won't run cleanup scripts, but will kill processes
    // Only runs if SIGINT/SIGTERM handlers didn't already clean up
    process.on('exit', () => {
      if (!this.isShuttingDown) {
        this.cleanupSync();
      }
    });
  }
}

export const runScriptService = new RunScriptService();
runScriptService.registerShutdownHandlers();
