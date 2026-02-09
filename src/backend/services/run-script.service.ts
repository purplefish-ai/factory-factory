import { type ChildProcess, spawn } from 'node:child_process';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { FactoryConfigService } from './factory-config.service';
import { createLogger } from './logger.service';
import { PortAllocationService } from './port-allocation.service';
import { runScriptStateMachine } from './run-script-state-machine.service';

const logger = createLogger('run-script-service');

// Max output buffer size per run script (500KB)
const MAX_OUTPUT_BUFFER_SIZE = 500 * 1024;

/**
 * Service for managing run script execution from factory-factory.json
 */
export class RunScriptService {
  // Track running processes by workspace ID
  private static runningProcesses = new Map<string, ChildProcess>();

  // Output buffers by workspace ID (persists even after process stops)
  private static outputBuffers = new Map<string, string>();

  // Output listeners by workspace ID
  private static outputListeners = new Map<string, Set<(data: string) => void>>();

  /**
   * Start the run script for a workspace
   * @param workspaceId - Workspace ID
   * @returns Object with success status, port (if allocated), and pid
   */
  static async startRunScript(workspaceId: string): Promise<{
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
      RunScriptService.runningProcesses.set(workspaceId, childProcess);

      // Clear and initialize output buffer for new run
      const startMessage = `\x1b[36m[Factory Factory]\x1b[0m Starting ${command}\n\n`;
      RunScriptService.outputBuffers.set(workspaceId, startMessage);

      // Register event handlers BEFORE async state transition to avoid missing events
      // Handle process exit
      childProcess.on('exit', async (code, signal) => {
        logger.info('Run script exited', {
          workspaceId,
          pid,
          code,
          signal,
        });

        RunScriptService.runningProcesses.delete(workspaceId);
        RunScriptService.outputListeners.delete(workspaceId);

        // Check current state - if STOPPING, the stopRunScript handler will complete the transition.
        // If already in a terminal state (COMPLETED/FAILED/IDLE), skip.
        // Otherwise, transition to COMPLETED or FAILED based on exit code.
        try {
          const ws = await workspaceAccessor.findById(workspaceId);
          const status = ws?.runScriptStatus;

          if (
            status === 'STOPPING' ||
            status === 'IDLE' ||
            status === 'COMPLETED' ||
            status === 'FAILED'
          ) {
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
          // Swallow state machine errors — the state was likely already transitioned
          logger.warn('Exit handler state transition failed (likely already transitioned)', {
            workspaceId,
            error: (error as Error).message,
          });
        }
      });

      // Capture and broadcast stdout/stderr
      const handleOutput = (data: Buffer) => {
        const output = data.toString();

        // Add to buffer (with size limit)
        const currentBuffer = RunScriptService.outputBuffers.get(workspaceId) ?? '';
        let newBuffer = currentBuffer + output;

        // Trim buffer if it exceeds max size (keep last N chars)
        if (newBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
          newBuffer = newBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
        }

        RunScriptService.outputBuffers.set(workspaceId, newBuffer);

        // Broadcast to listeners
        const listeners = RunScriptService.outputListeners.get(workspaceId);
        if (listeners) {
          for (const listener of listeners) {
            listener(output);
          }
        }
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
        RunScriptService.runningProcesses.delete(workspaceId);
        // Transition to FAILED via state machine (with error handling for race conditions)
        try {
          await runScriptStateMachine.markFailed(workspaceId);
        } catch (stateError) {
          logger.warn(
            'Failed to transition to FAILED on spawn error (likely already transitioned)',
            {
              workspaceId,
              error: stateError,
            }
          );
        }
      });

      // Transition to RUNNING state AFTER registering all event handlers
      // This ensures we don't miss any events that fire during the async DB operation.
      // If the process exits very fast, the exit handler may have already transitioned
      // STARTING → COMPLETED/FAILED before we get here. In that case, markRunning will
      // fail because the CAS expects STARTING but finds COMPLETED/FAILED. That's fine —
      // the process lifecycle completed correctly.
      try {
        await runScriptStateMachine.markRunning(workspaceId, {
          pid,
          port,
        });
      } catch (markRunningError) {
        // Check if the process already exited and the exit handler transitioned the state
        const ws = await workspaceAccessor.findById(workspaceId);
        const currentStatus = ws?.runScriptStatus;
        if (currentStatus === 'COMPLETED' || currentStatus === 'FAILED') {
          logger.info(
            'Process exited before markRunning — exit handler already transitioned state',
            {
              workspaceId,
              pid,
              currentStatus,
            }
          );
          return { success: true, port, pid };
        }
        // Concurrent stop completed (STARTING → STOPPING → IDLE) while we were spawning.
        // Kill the orphaned process so it doesn't leak.
        if (currentStatus === 'IDLE' || currentStatus === 'STOPPING') {
          logger.info('Concurrent stop completed before markRunning — killing orphaned process', {
            workspaceId,
            pid,
            currentStatus,
          });
          try {
            childProcess.kill('SIGTERM');
          } catch {
            /* already dead */
          }
          RunScriptService.runningProcesses.delete(workspaceId);
          return { success: false, error: 'Run script was stopped before it could start' };
        }
        throw markRunningError;
      }

      return {
        success: true,
        port,
        pid,
      };
    } catch (error) {
      logger.error('Failed to start run script', error as Error, {
        workspaceId,
      });

      // Only transition to FAILED if THIS call initiated the STARTING state
      // If the error is a state machine error (e.g., concurrent start), don't mark as FAILED
      const isStateMachineError = (error as Error).name === 'RunScriptStateMachineError';

      if (!isStateMachineError) {
        // This was a real error (spawn failure, port allocation, etc.)
        // Transition to FAILED if we're stuck in STARTING state
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

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Stop the run script for a workspace
   * @param workspaceId - Workspace ID
   * @returns Object with success status
   */
  static async stopRunScript(workspaceId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      const childProcess = RunScriptService.runningProcesses.get(workspaceId);
      const pid = workspace.runScriptPid;
      const status = workspace.runScriptStatus;

      // Already stopped or idle — nothing to do
      if (status === 'IDLE' || status === 'STOPPING') {
        return { success: true };
      }

      // Terminal states: kill any orphaned process, then reset to IDLE
      if (status === 'COMPLETED' || status === 'FAILED') {
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
          RunScriptService.runningProcesses.delete(workspaceId);
        }
        // Reset to IDLE so user can start again
        try {
          await runScriptStateMachine.reset(workspaceId);
        } catch {
          // State may have already moved — that's fine
        }
        return { success: true };
      }

      // STARTING or RUNNING — attempt STOPPING transition
      if (!(childProcess || pid)) {
        // No process reference and not in a stoppable state
        return { success: false, error: 'No run script is running' };
      }

      // Transition to STOPPING (works from both STARTING and RUNNING)
      try {
        await runScriptStateMachine.beginStopping(workspaceId);
      } catch (error) {
        // Race: state moved to a terminal state between our read and the CAS write.
        // Re-read and treat as already stopped.
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
          return { success: true };
        }
        throw error; // Unexpected — re-throw
      }

      // Run cleanup script if configured
      if (workspace.runScriptCleanupCommand && workspace.worktreePath) {
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

          // Add error handlers for stdout/stderr streams to prevent unhandled errors
          cleanupProcess.stdout?.on('error', (error) => {
            logger.warn('Cleanup script stdout stream error', { workspaceId, error });
          });
          cleanupProcess.stderr?.on('error', (error) => {
            logger.warn('Cleanup script stderr stream error', { workspaceId, error });
          });

          // Wait for cleanup to complete (with timeout)
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              logger.warn('Cleanup script timed out, proceeding anyway', {
                workspaceId,
              });
              cleanupProcess.kill('SIGTERM');
              resolve();
            }, 5000); // 5 second timeout

            cleanupProcess.on('exit', (code) => {
              clearTimeout(timeout);
              logger.info('Cleanup script completed', {
                workspaceId,
                exitCode: code,
              });
              resolve();
            });

            cleanupProcess.on('error', (error) => {
              clearTimeout(timeout);
              logger.error('Cleanup script error', error, {
                workspaceId,
              });
              resolve(); // Continue despite error
            });
          });
        } catch (error) {
          logger.error('Failed to run cleanup script', error as Error, {
            workspaceId,
          });
          // Continue with stopping the process even if cleanup fails
        }
      }

      // Kill the process
      if (childProcess) {
        logger.info('Stopping run script via stored process', {
          workspaceId,
          pid: childProcess.pid,
        });
        childProcess.kill('SIGTERM');
        RunScriptService.runningProcesses.delete(workspaceId);
      } else if (pid) {
        // Fallback: kill by PID if we don't have the process reference
        logger.info('Stopping run script via PID', { workspaceId, pid });
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          // Process might already be dead
          logger.warn('Failed to kill process, might already be stopped', {
            workspaceId,
            pid,
            error,
          });
        }
      }

      // Transition to IDLE state via state machine (completes stopping)
      await runScriptStateMachine.completeStopping(workspaceId);

      return { success: true };
    } catch (error) {
      logger.error('Failed to stop run script', error as Error, {
        workspaceId,
      });
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get the status of the run script for a workspace
   */
  static async getRunScriptStatus(workspaceId: string) {
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
  static getOutputBuffer(workspaceId: string): string {
    return RunScriptService.outputBuffers.get(workspaceId) ?? '';
  }

  /**
   * Subscribe to output from a workspace's run script
   * @returns Unsubscribe function
   */
  static subscribeToOutput(workspaceId: string, listener: (data: string) => void): () => void {
    let listeners = RunScriptService.outputListeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      RunScriptService.outputListeners.set(workspaceId, listeners);
    }
    listeners.add(listener);

    // Return unsubscribe function
    return () => {
      const listeners = RunScriptService.outputListeners.get(workspaceId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          RunScriptService.outputListeners.delete(workspaceId);
        }
      }
    };
  }

  /**
   * Cleanup all running scripts (called on server shutdown)
   */
  static async cleanup() {
    logger.info('Cleaning up all running scripts', {
      count: RunScriptService.runningProcesses.size,
    });

    // Stop all running scripts using the stopRunScript method
    // This ensures cleanup scripts are run
    const workspaceIds = Array.from(RunScriptService.runningProcesses.keys());
    await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        try {
          await RunScriptService.stopRunScript(workspaceId);
        } catch (error) {
          logger.error('Failed to stop run script during cleanup', error as Error, {
            workspaceId,
          });
        }
      })
    );

    RunScriptService.runningProcesses.clear();
  }

  /**
   * Synchronous cleanup for 'exit' event - kills processes without running cleanup scripts
   * @internal
   */
  static cleanupSync() {
    logger.info('Process exiting, killing any remaining run scripts');
    for (const [workspaceId, childProcess] of RunScriptService.runningProcesses.entries()) {
      try {
        childProcess.kill('SIGKILL');
        logger.info('Force killed run script on exit', {
          workspaceId,
          pid: childProcess.pid,
        });
      } catch {
        // Ignore errors during forced shutdown
      }
    }
    RunScriptService.runningProcesses.clear();
    RunScriptService.outputBuffers.clear();
    RunScriptService.outputListeners.clear();
  }
}

// Track whether we're shutting down to prevent double cleanup
let isShuttingDown = false;

// Register cleanup handlers for graceful shutdown
// These handlers allow async cleanup (unlike 'exit' which is synchronous)
// Note: We don't call process.exit() to allow other shutdown handlers to run
process.on('SIGINT', async () => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info('Received SIGINT, cleaning up run scripts');
  await RunScriptService.cleanup();
});

process.on('SIGTERM', async () => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info('Received SIGTERM, cleaning up run scripts');
  await RunScriptService.cleanup();
});

// Fallback synchronous cleanup for 'exit' event
// This won't run cleanup scripts, but will kill processes
// Only runs if SIGINT/SIGTERM handlers didn't already clean up
process.on('exit', () => {
  if (!isShuttingDown) {
    RunScriptService.cleanupSync();
  }
});
