import { type ChildProcess, spawn } from 'node:child_process';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { FactoryConfigService } from './factory-config.service';
import { createLogger } from './logger.service';
import { PortAllocationService } from './port-allocation.service';

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

      // Check if already running
      if (workspace.runScriptStatus === 'RUNNING' && workspace.runScriptPid) {
        // Verify process still exists
        try {
          process.kill(workspace.runScriptPid, 0);
          return {
            success: false,
            error: 'Run script is already running',
            pid: workspace.runScriptPid,
            port: workspace.runScriptPort ?? undefined,
          };
        } catch {
          // Process doesn't exist, cleanup stale state
          logger.warn('Stale run script process detected, cleaning up', {
            workspaceId,
            pid: workspace.runScriptPid,
          });
          await workspaceAccessor.update(workspaceId, {
            runScriptStatus: 'IDLE',
            runScriptPid: null,
            runScriptPort: null,
            runScriptStartedAt: null,
          });
        }
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

      // Update workspace status
      await workspaceAccessor.update(workspaceId, {
        runScriptStatus: 'RUNNING',
        runScriptPid: pid,
        runScriptPort: port ?? null,
        runScriptStartedAt: new Date(),
      });

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

        const status = code === 0 ? 'COMPLETED' : 'FAILED';
        await workspaceAccessor.update(workspaceId, {
          runScriptStatus: status,
          runScriptPid: null,
          runScriptPort: null,
        });
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
      childProcess.stderr?.on('data', handleOutput);

      // Handle spawn errors
      childProcess.on('error', async (error) => {
        logger.error('Run script spawn error', error, { workspaceId, pid });
        RunScriptService.runningProcesses.delete(workspaceId);
        await workspaceAccessor.update(workspaceId, {
          runScriptStatus: 'FAILED',
          runScriptPid: null,
          runScriptPort: null,
        });
      });

      return {
        success: true,
        port,
        pid,
      };
    } catch (error) {
      logger.error('Failed to start run script', error as Error, {
        workspaceId,
      });
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

      if (!(childProcess || pid)) {
        return {
          success: false,
          error: 'No run script is running',
        };
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

      // Update workspace status
      await workspaceAccessor.update(workspaceId, {
        runScriptStatus: 'IDLE',
        runScriptPid: null,
        runScriptPort: null,
      });

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

    // Verify process is actually running if status says RUNNING
    if (workspace.runScriptStatus === 'RUNNING' && workspace.runScriptPid) {
      try {
        process.kill(workspace.runScriptPid, 0);
        // Process exists
      } catch {
        // Process doesn't exist, update status
        logger.warn('Detected stale run script status, updating', {
          workspaceId,
          pid: workspace.runScriptPid,
        });
        await workspaceAccessor.update(workspaceId, {
          runScriptStatus: 'FAILED',
          runScriptPid: null,
          runScriptPort: null,
        });
        return {
          status: 'FAILED' as const,
          hasRunScript: !!workspace.runScriptCommand,
          runScriptCommand: workspace.runScriptCommand,
        };
      }
    }

    return {
      status: workspace.runScriptStatus,
      pid: workspace.runScriptPid,
      port: workspace.runScriptPort,
      startedAt: workspace.runScriptStartedAt,
      hasRunScript: !!workspace.runScriptCommand,
      runScriptCommand: workspace.runScriptCommand,
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

// Register cleanup handlers for graceful shutdown
// These handlers allow async cleanup (unlike 'exit' which is synchronous)
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, cleaning up run scripts');
  await RunScriptService.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, cleaning up run scripts');
  await RunScriptService.cleanup();
  process.exit(0);
});

// Fallback synchronous cleanup for 'exit' event
// This won't run cleanup scripts, but will kill processes
process.on('exit', () => {
  RunScriptService.cleanupSync();
});
