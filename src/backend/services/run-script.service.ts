import { type ChildProcess, spawn } from 'node:child_process';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { FactoryConfigService } from './factory-config.service';
import { createLogger } from './logger.service';
import { PortAllocationService } from './port-allocation.service';

const logger = createLogger('run-script-service');

/**
 * Service for managing run script execution from factory-factory.json
 */
export class RunScriptService {
  // Track running processes by workspace ID
  private static runningProcesses = new Map<string, ChildProcess>();

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

        const status = code === 0 ? 'COMPLETED' : 'FAILED';
        await workspaceAccessor.update(workspaceId, {
          runScriptStatus: status,
          runScriptPid: null,
          runScriptPort: null,
        });
      });

      // Log stdout/stderr
      childProcess.stdout?.on('data', (data) => {
        logger.debug('Run script stdout', {
          workspaceId,
          pid,
          output: data.toString(),
        });
      });

      childProcess.stderr?.on('data', (data) => {
        logger.debug('Run script stderr', {
          workspaceId,
          pid,
          output: data.toString(),
        });
      });

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
   * Cleanup all running scripts (called on server shutdown)
   */
  static cleanup() {
    logger.info('Cleaning up all running scripts', {
      count: RunScriptService.runningProcesses.size,
    });

    for (const [workspaceId, childProcess] of RunScriptService.runningProcesses.entries()) {
      try {
        childProcess.kill('SIGTERM');
        logger.info('Killed run script on cleanup', {
          workspaceId,
          pid: childProcess.pid,
        });
      } catch (error) {
        logger.error('Failed to kill run script on cleanup', error as Error, {
          workspaceId,
          pid: childProcess.pid,
        });
      }
    }

    RunScriptService.runningProcesses.clear();
  }
}

// Register cleanup handler
process.on('exit', () => {
  RunScriptService.cleanup();
});
