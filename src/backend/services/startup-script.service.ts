/**
 * Startup Script Service
 *
 * Handles execution of startup scripts when workspaces are created.
 * Supports both inline shell commands and script file paths.
 *
 * Provides real-time output streaming via subscription pattern for WebSocket handlers.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Workspace, WorkspaceStatus } from '@prisma-gen/client';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { createLogger } from './logger.service';
import { workspaceStateMachine } from './workspace-state-machine.service';

const logger = createLogger('startup-script');

/** Callback type for streaming output during script execution */
type OutputCallback = (output: string) => void;

/** Callback type for status change notifications */
type StatusCallback = (status: WorkspaceStatus, errorMessage?: string | null) => void;

/** Maximum size of in-memory output buffer per workspace (100KB) */
const MAX_OUTPUT_BUFFER_SIZE = 100 * 1024;

export interface StartupScriptResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class StartupScriptService {
  // ============================================================================
  // Real-time Subscription System for WebSocket Handlers
  // ============================================================================

  /** Subscribers for output events per workspace */
  private outputSubscribers = new Map<string, Set<OutputCallback>>();

  /** Subscribers for status change events per workspace */
  private statusSubscribers = new Map<string, Set<StatusCallback>>();

  /** In-memory output buffers per workspace (for late-joining WebSocket clients) */
  private outputBuffers = new Map<string, string>();

  /**
   * Subscribe to real-time output for a workspace.
   * Returns unsubscribe function.
   */
  subscribeToOutput(workspaceId: string, callback: OutputCallback): () => void {
    if (!this.outputSubscribers.has(workspaceId)) {
      this.outputSubscribers.set(workspaceId, new Set());
    }
    this.outputSubscribers.get(workspaceId)?.add(callback);

    return () => {
      const subscribers = this.outputSubscribers.get(workspaceId);
      if (subscribers) {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          this.outputSubscribers.delete(workspaceId);
        }
      }
    };
  }

  /**
   * Subscribe to status changes for a workspace.
   * Returns unsubscribe function.
   */
  subscribeToStatus(workspaceId: string, callback: StatusCallback): () => void {
    if (!this.statusSubscribers.has(workspaceId)) {
      this.statusSubscribers.set(workspaceId, new Set());
    }
    this.statusSubscribers.get(workspaceId)?.add(callback);

    return () => {
      const subscribers = this.statusSubscribers.get(workspaceId);
      if (subscribers) {
        subscribers.delete(callback);
        if (subscribers.size === 0) {
          this.statusSubscribers.delete(workspaceId);
        }
      }
    };
  }

  /**
   * Get buffered output for a workspace (for late-joining clients).
   */
  getOutputBuffer(workspaceId: string): string {
    return this.outputBuffers.get(workspaceId) ?? '';
  }

  /**
   * Emit output to all subscribers and buffer it.
   */
  private emitOutput(workspaceId: string, output: string): void {
    // Buffer the output (with size limit)
    const currentBuffer = this.outputBuffers.get(workspaceId) ?? '';
    let newBuffer = currentBuffer + output;
    if (newBuffer.length > MAX_OUTPUT_BUFFER_SIZE) {
      // Keep the most recent output
      newBuffer = newBuffer.slice(-MAX_OUTPUT_BUFFER_SIZE);
    }
    this.outputBuffers.set(workspaceId, newBuffer);

    // Notify subscribers
    const subscribers = this.outputSubscribers.get(workspaceId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(output);
        } catch (error) {
          logger.warn('Error in output subscriber callback', { workspaceId, error });
        }
      }
    }
  }

  /**
   * Emit status change to all subscribers.
   */
  private emitStatus(
    workspaceId: string,
    status: WorkspaceStatus,
    errorMessage?: string | null
  ): void {
    const subscribers = this.statusSubscribers.get(workspaceId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(status, errorMessage);
        } catch (error) {
          logger.warn('Error in status subscriber callback', { workspaceId, error });
        }
      }
    }
  }

  /**
   * Clear output buffer for a workspace (called on retry or archive).
   */
  clearOutputBuffer(workspaceId: string): void {
    this.outputBuffers.delete(workspaceId);
  }

  // ============================================================================
  // Script Execution
  // ============================================================================

  /**
   * Run the startup script for a workspace synchronously.
   * Updates workspace status throughout execution via state machine.
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
      await workspaceStateMachine.markReady(workspace.id);
      return {
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
      };
    }

    // Note: Workspace should already be in PROVISIONING state from init.trpc.ts
    // We don't transition here to avoid double-transitioning

    const startTime = Date.now();
    const timeoutMs = (project.startupScriptTimeout ?? 300) * 1000;

    // Clear any previous output from retry attempts
    await workspaceAccessor.clearInitOutput(workspace.id);
    this.clearOutputBuffer(workspace.id);

    // Create output streaming callback with debouncing
    const { callback: outputCallback, flush: flushOutput } = this.createDebouncedOutputCallback(
      workspace.id
    );

    try {
      const result = await this.executeScript(
        worktreePath,
        project.startupScriptCommand,
        project.startupScriptPath,
        timeoutMs,
        5000,
        outputCallback
      );

      // Flush any remaining buffered output
      await flushOutput();

      const durationMs = Date.now() - startTime;

      if (result.success) {
        await workspaceStateMachine.markReady(workspace.id);
        this.emitStatus(workspace.id, 'READY');
        logger.info('Startup script completed successfully', {
          workspaceId: workspace.id,
          durationMs,
        });
      } else {
        const errorMessage = result.timedOut
          ? `Script timed out after ${project.startupScriptTimeout}s`
          : `Script exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`;

        await workspaceStateMachine.markFailed(workspace.id, errorMessage);
        this.emitStatus(workspace.id, 'FAILED', errorMessage);
        logger.error('Startup script failed', {
          workspaceId: workspace.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(0, 500),
        });
      }

      return { ...result, durationMs };
    } catch (error) {
      // Flush any remaining buffered output before handling error
      await flushOutput();

      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await workspaceStateMachine.markFailed(workspace.id, errorMessage);
      this.emitStatus(workspace.id, 'FAILED', errorMessage);
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
   *
   * @param gracePeriodMs - Time between SIGTERM and SIGKILL (default 5000ms)
   * @param onOutput - Optional callback for streaming output as it arrives
   */
  private async executeScript(
    cwd: string,
    command: string | null,
    scriptPath: string | null,
    timeoutMs: number,
    gracePeriodMs = 5000,
    onOutput?: OutputCallback
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

        // Stream output via callback if provided
        if (onOutput) {
          onOutput(str);
        }

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

  /**
   * Create a debounced callback that batches output writes to the database.
   * Flushes every 500ms or when buffer exceeds 4KB, whichever comes first.
   * Returns both the callback and a flush function to call when script completes.
   */
  private createDebouncedOutputCallback(workspaceId: string): {
    callback: OutputCallback;
    flush: () => Promise<void>;
  } {
    let buffer = '';
    let flushTimeout: NodeJS.Timeout | null = null;

    const flush = async (): Promise<void> => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }

      if (buffer.length === 0) {
        return;
      }

      const output = buffer;
      buffer = '';

      // Write to database and wait for completion
      try {
        await workspaceAccessor.appendInitOutput(workspaceId, output);
      } catch (error) {
        logger.warn('Failed to append init output', { workspaceId, error });
      }
    };

    const callback = (output: string): void => {
      buffer += output;

      // Emit output immediately to WebSocket subscribers (real-time)
      this.emitOutput(workspaceId, output);

      // Flush immediately if buffer is large enough
      if (buffer.length >= 4096) {
        flush();
        return;
      }

      // Otherwise, schedule a debounced flush
      if (!flushTimeout) {
        flushTimeout = setTimeout(flush, 500);
      }
    };

    return { callback, flush };
  }
}

export const startupScriptService = new StartupScriptService();
