/**
 * Startup Script Service
 *
 * Handles execution of startup scripts when workspaces are created.
 * Supports both inline shell commands and script file paths.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Project, Workspace } from '@prisma-gen/client';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { createLogger } from './logger.service';

const logger = createLogger('startup-script');

export interface StartupScriptResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

class StartupScriptService {
  /**
   * Run the startup script for a workspace synchronously.
   * Updates workspace initStatus throughout execution.
   *
   * @returns Result of script execution
   */
  async runStartupScript(workspace: Workspace, project: Project): Promise<StartupScriptResult> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      throw new Error('Workspace has no worktree path');
    }

    // Check if project has a startup script configured
    if (!(project.startupScriptCommand || project.startupScriptPath)) {
      // No script configured - mark as ready immediately
      await workspaceAccessor.updateInitStatus(workspace.id, 'READY');
      return {
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
      };
    }

    // Mark as initializing
    await workspaceAccessor.updateInitStatus(workspace.id, 'INITIALIZING');

    const startTime = Date.now();
    const timeoutMs = (project.startupScriptTimeout ?? 300) * 1000;

    try {
      const result = await this.executeScript(
        worktreePath,
        project.startupScriptCommand,
        project.startupScriptPath,
        timeoutMs
      );

      const durationMs = Date.now() - startTime;

      if (result.success) {
        await workspaceAccessor.updateInitStatus(workspace.id, 'READY');
        logger.info('Startup script completed successfully', {
          workspaceId: workspace.id,
          durationMs,
        });
      } else {
        const errorMessage = result.timedOut
          ? `Script timed out after ${project.startupScriptTimeout}s`
          : `Script exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`;

        await workspaceAccessor.updateInitStatus(workspace.id, 'FAILED', errorMessage);
        logger.error('Startup script failed', {
          workspaceId: workspace.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(0, 500),
        });
      }

      return { ...result, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await workspaceAccessor.updateInitStatus(workspace.id, 'FAILED', errorMessage);
      logger.error('Startup script execution error', error as Error, {
        workspaceId: workspace.id,
      });

      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: errorMessage,
        timedOut: false,
        durationMs,
      };
    }
  }

  /**
   * Validate that a script path doesn't escape the repository root.
   * Prevents path traversal attacks like "../../etc/passwd".
   */
  validateScriptPath(scriptPath: string, repoRoot: string): { valid: boolean; error?: string } {
    // Normalize and resolve the full path
    const normalizedPath = path.normalize(scriptPath);

    // Check for obvious traversal attempts
    if (normalizedPath.startsWith('..') || normalizedPath.startsWith('/')) {
      return { valid: false, error: 'Script path must be relative to repository root' };
    }

    // Resolve to absolute and verify it's within repo
    const fullPath = path.resolve(repoRoot, normalizedPath);
    const resolvedRepoRoot = path.resolve(repoRoot);

    if (!fullPath.startsWith(resolvedRepoRoot + path.sep) && fullPath !== resolvedRepoRoot) {
      return { valid: false, error: 'Script path escapes repository root' };
    }

    return { valid: true };
  }

  /**
   * Execute the script using spawn.
   * Commands are configured by project owners and run through bash.
   */
  private executeScript(
    cwd: string,
    command: string | null,
    scriptPath: string | null,
    timeoutMs: number
  ): Promise<Omit<StartupScriptResult, 'durationMs'>> {
    return new Promise((resolve) => {
      // Build the bash arguments based on script type
      const bashArgs = this.buildBashArgs(cwd, command, scriptPath);

      if (bashArgs === null) {
        // Neither command nor scriptPath provided
        resolve({ success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false });
        return;
      }

      if (bashArgs.error) {
        resolve({
          success: false,
          exitCode: null,
          stdout: '',
          stderr: bashArgs.error,
          timedOut: false,
        });
        return;
      }

      const spawnOptions = { cwd, env: { ...process.env, WORKSPACE_PATH: cwd } };
      const proc = spawn('bash', bashArgs.args, spawnOptions);

      let timedOut = false;
      let stdout = '';
      let stderr = '';
      let killTimeoutHandle: NodeJS.Timeout | undefined;

      const cleanupTimeouts = (): void => {
        clearTimeout(timeoutHandle);
        if (killTimeoutHandle) {
          clearTimeout(killTimeoutHandle);
        }
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        killTimeoutHandle = setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeoutMs);

      const appendOutput = (target: 'stdout' | 'stderr', data: Buffer): void => {
        const str = data.toString();
        const maxSize = 1024 * 1024;
        const keepSize = 512 * 1024;

        if (target === 'stdout') {
          stdout += str;
          if (stdout.length > maxSize) {
            stdout = `[...truncated...]\n${stdout.slice(-keepSize)}`;
          }
        } else {
          stderr += str;
          if (stderr.length > maxSize) {
            stderr = `[...truncated...]\n${stderr.slice(-keepSize)}`;
          }
        }
      };

      proc.stdout?.on('data', (data: Buffer) => appendOutput('stdout', data));
      proc.stderr?.on('data', (data: Buffer) => appendOutput('stderr', data));

      proc.on('close', (code) => {
        cleanupTimeouts();
        resolve({ success: code === 0 && !timedOut, exitCode: code, stdout, stderr, timedOut });
      });

      proc.on('error', (error) => {
        cleanupTimeouts();
        resolve({ success: false, exitCode: null, stdout, stderr: error.message, timedOut: false });
      });
    });
  }

  /**
   * Build bash arguments for the script execution.
   * Returns null if no script is configured, or an error object if validation fails.
   */
  private buildBashArgs(
    cwd: string,
    command: string | null,
    scriptPath: string | null
  ): { args: string[]; error?: never } | { args?: never; error: string } | null {
    if (scriptPath) {
      const validation = this.validateScriptPath(scriptPath, cwd);
      if (!validation.valid) {
        return { error: validation.error || 'Invalid script path' };
      }
      return { args: [path.join(cwd, scriptPath)] };
    }

    if (command) {
      return { args: ['-c', command] };
    }

    return null;
  }

  /**
   * Check if a project has startup script configured.
   */
  hasStartupScript(project: Project): boolean {
    return !!(project.startupScriptCommand || project.startupScriptPath);
  }
}

export const startupScriptService = new StartupScriptService();
