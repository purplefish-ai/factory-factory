/**
 * Startup Script Service
 *
 * Handles execution of startup scripts when workspaces are created.
 * Supports both inline shell commands and script file paths.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Workspace } from '@prisma-gen/client';
import { createLogger } from './logger.service';
import { completeProvisioning, failProvisioning } from './workspace-state-machine';

const logger = createLogger('startup-script');

/** Log a warning if a state transition failed */
function logTransitionFailure(
  context: string,
  workspaceId: string,
  result: { success: false; reason: string; currentStatus?: string }
): void {
  logger.warn(`Failed to ${context}`, {
    workspaceId,
    reason: result.reason,
    currentStatus: result.currentStatus,
  });
}

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
   * Updates workspace status throughout execution.
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
      return this.handleNoScript(workspace.id);
    }

    // Note: Caller is responsible for setting status to PROVISIONING before calling this
    // (either initializeWorkspaceWorktree or incrementRetryCount already did this)

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
      await this.handleScriptResult(
        workspace.id,
        result,
        project.startupScriptTimeout ?? 300,
        durationMs
      );
      return { ...result, durationMs };
    } catch (error) {
      return this.handleScriptError(workspace.id, error, Date.now() - startTime);
    }
  }

  /** Handle case when no startup script is configured */
  private async handleNoScript(workspaceId: string): Promise<StartupScriptResult> {
    const transitionResult = await completeProvisioning(workspaceId);
    if (!transitionResult.success) {
      logTransitionFailure('complete provisioning (no script)', workspaceId, transitionResult);
    }
    return { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
  }

  /** Handle script execution result and update workspace status */
  private async handleScriptResult(
    workspaceId: string,
    result: Omit<StartupScriptResult, 'durationMs'>,
    timeoutSeconds: number,
    durationMs: number
  ): Promise<void> {
    if (result.success) {
      const transitionResult = await completeProvisioning(workspaceId);
      if (!transitionResult.success) {
        logTransitionFailure('complete provisioning', workspaceId, transitionResult);
      }
      logger.info('Startup script completed successfully', { workspaceId, durationMs });
    } else {
      const errorMessage = result.timedOut
        ? `Script timed out after ${timeoutSeconds}s`
        : `Script exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`;
      const transitionResult = await failProvisioning(workspaceId, errorMessage);
      if (!transitionResult.success) {
        logTransitionFailure('mark provisioning as failed', workspaceId, transitionResult);
      }
      logger.error('Startup script failed', {
        workspaceId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stderr: result.stderr.slice(0, 500),
      });
    }
  }

  /** Handle script execution error */
  private async handleScriptError(
    workspaceId: string,
    error: unknown,
    durationMs: number
  ): Promise<StartupScriptResult> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const transitionResult = await failProvisioning(workspaceId, errorMessage);
    if (!transitionResult.success) {
      logTransitionFailure('mark provisioning as failed', workspaceId, transitionResult);
    }
    logger.error('Startup script execution error', error as Error, { workspaceId });
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: errorMessage,
      timedOut: false,
      durationMs,
    };
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
   *
   * @param gracePeriodMs - Time between SIGTERM and SIGKILL (default 5000ms)
   */
  private async executeScript(
    cwd: string,
    command: string | null,
    scriptPath: string | null,
    timeoutMs: number,
    gracePeriodMs = 5000
  ): Promise<Omit<StartupScriptResult, 'durationMs'>> {
    // Build the bash arguments based on script type
    const bashArgs = this.buildBashArgs(cwd, command, scriptPath);

    if (bashArgs === null) {
      // Neither command nor scriptPath provided
      return { success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }

    if (bashArgs.error) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: bashArgs.error,
        timedOut: false,
      };
    }

    // For script paths, verify the file is readable before execution
    if (scriptPath) {
      const readCheck = await this.validateScriptReadable(scriptPath, cwd);
      if (!readCheck.readable) {
        return {
          success: false,
          exitCode: null,
          stdout: '',
          stderr: readCheck.error || 'Script not readable',
          timedOut: false,
        };
      }
    }

    return new Promise((resolve) => {
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
        killTimeoutHandle = setTimeout(() => proc.kill('SIGKILL'), gracePeriodMs);
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
   * Check if a script file exists and is readable.
   * Called before execution to provide better error messages.
   */
  async validateScriptReadable(
    scriptPath: string,
    repoRoot: string
  ): Promise<{ readable: boolean; error?: string }> {
    const fullPath = path.resolve(repoRoot, scriptPath);
    try {
      await access(fullPath, constants.R_OK);
      return { readable: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { readable: false, error: `Script not found: ${scriptPath}` };
      }
      if (code === 'EACCES') {
        return { readable: false, error: `Script not readable: ${scriptPath}` };
      }
      return { readable: false, error: `Cannot access script: ${scriptPath}` };
    }
  }

  /**
   * Check if a project has startup script configured.
   */
  hasStartupScript(project: Project): boolean {
    return !!(project.startupScriptCommand || project.startupScriptPath);
  }
}

export const startupScriptService = new StartupScriptService();
