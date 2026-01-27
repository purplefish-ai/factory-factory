/**
 * Terminal Service
 *
 * Manages PTY (pseudo-terminal) instances for workspaces using node-pty.
 * Each workspace can have multiple terminal sessions that persist across
 * WebSocket reconnections. Includes resource monitoring for CPU and memory usage.
 *
 * NOTE: Unlike Claude processes, terminals are NEVER auto-killed based on
 * resource usage or idle time. Terminals cannot be resumed once killed,
 * so cleanup only happens on explicit user action or server shutdown.
 * Resource monitoring here is purely informational for the admin dashboard.
 */

import type { IPty } from 'node-pty';
import pidusage from 'pidusage';
import { createLogger } from './logger.service';

const logger = createLogger('terminal');

// =============================================================================
// Types
// =============================================================================

/**
 * Resource usage snapshot for a terminal.
 */
export interface TerminalResourceUsage {
  /** CPU usage percentage (0-100+) */
  cpu: number;
  /** Memory usage in bytes */
  memory: number;
  /** Timestamp of measurement */
  timestamp: Date;
}

export interface TerminalInstance {
  id: string;
  workspaceId: string;
  pty: IPty;
  cols: number;
  rows: number;
  createdAt: Date;
  // Disposables for cleaning up event listeners
  disposables: (() => void)[];
  // Last resource usage snapshot
  lastResourceUsage?: TerminalResourceUsage;
  // Rolling output buffer for restoration after reconnect
  outputBuffer: string;
}

export interface CreateTerminalOptions {
  workspaceId: string;
  workingDir: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface CreateTerminalResult {
  terminalId: string;
  pid: number;
}

export interface TerminalOutput {
  terminalId: string;
  data: string;
}

// =============================================================================
// Terminal Service Class
// =============================================================================

class TerminalService {
  // Map of workspaceId -> Map of terminalId -> TerminalInstance
  private terminals = new Map<string, Map<string, TerminalInstance>>();

  // Output listeners by terminalId
  private outputListeners = new Map<string, Set<(data: string) => void>>();

  // Exit listeners by terminalId
  private exitListeners = new Map<string, Set<(exitCode: number) => void>>();

  // Resource monitoring interval
  private monitoringInterval: NodeJS.Timeout | null = null;
  private static readonly MONITORING_INTERVAL_MS = 5000; // 5 seconds

  // Max output buffer size per terminal (100KB) for restoration after reconnect
  private static readonly MAX_OUTPUT_BUFFER_SIZE = 100 * 1024;

  /**
   * Ensure resource monitoring is running if there are terminals.
   * Called after creating a terminal.
   */
  private ensureResourceMonitoring(): void {
    if (this.monitoringInterval || this.getActiveTerminalCount() === 0) {
      return;
    }
    this.startResourceMonitoring();
  }

  /**
   * Start periodic resource monitoring for all terminals.
   */
  private startResourceMonitoring(): void {
    if (this.monitoringInterval) {
      return; // Already running
    }

    logger.debug('Starting terminal resource monitoring');
    this.monitoringInterval = setInterval(async () => {
      // Stop monitoring if no terminals
      if (this.getActiveTerminalCount() === 0) {
        this.stopResourceMonitoring();
        return;
      }

      try {
        await this.updateAllTerminalResources();
      } catch (error) {
        logger.error('Failed to update terminal resources', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, TerminalService.MONITORING_INTERVAL_MS);
  }

  /**
   * Update resource usage for all terminals.
   */
  private async updateAllTerminalResources(): Promise<void> {
    for (const workspaceTerminals of this.terminals.values()) {
      for (const instance of workspaceTerminals.values()) {
        await this.updateTerminalResource(instance);
      }
    }
  }

  /**
   * Update resource usage for a single terminal.
   */
  private async updateTerminalResource(instance: TerminalInstance): Promise<void> {
    const pid = instance.pty.pid;
    if (!pid) {
      return;
    }

    try {
      const usage = await pidusage(pid);
      instance.lastResourceUsage = {
        cpu: usage.cpu,
        memory: usage.memory,
        timestamp: new Date(),
      };
    } catch (error) {
      logger.debug('Failed to get terminal resource usage', {
        terminalId: instance.id,
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
      instance.lastResourceUsage = undefined;
    }
  }

  /**
   * Stop resource monitoring (for graceful shutdown or when no terminals exist).
   */
  private stopResourceMonitoring(): void {
    if (this.monitoringInterval) {
      logger.debug('Stopping terminal resource monitoring');
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Lazy load node-pty to handle cases where it's not installed
   */
  private async getNodePty(): Promise<typeof import('node-pty')> {
    try {
      // Dynamic import required for native module that may not be available at build time
      // biome-ignore lint/plugin: dynamic import is intentional for native module
      return await import('node-pty');
    } catch (error) {
      logger.error('node-pty not available', error as Error);
      throw new Error('node-pty is not installed. Please run: pnpm add node-pty');
    }
  }

  /**
   * Create a new terminal instance for a workspace
   */
  async createTerminal(options: CreateTerminalOptions): Promise<CreateTerminalResult> {
    const { workspaceId, workingDir, cols = 80, rows = 24, shell } = options;

    const nodePty = await this.getNodePty();

    // Generate unique terminal ID
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Determine shell to use
    const shellPath = shell || process.env.SHELL || '/bin/bash';
    const shellArgs: string[] = [];

    logger.info('Creating terminal', {
      terminalId,
      workspaceId,
      workingDir,
      shell: shellPath,
      cols,
      rows,
    });

    // Spawn PTY process
    const pty = nodePty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workingDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    // Track disposables for cleanup
    const disposables: (() => void)[] = [];

    // Set up output listener - also accumulates output in buffer for restoration
    const dataDisposable = pty.onData((data: string) => {
      // Accumulate output in buffer for restoration after reconnect
      const instance = this.terminals.get(workspaceId)?.get(terminalId);
      if (instance) {
        instance.outputBuffer += data;
        // Limit buffer size by trimming from the beginning
        if (instance.outputBuffer.length > TerminalService.MAX_OUTPUT_BUFFER_SIZE) {
          instance.outputBuffer = instance.outputBuffer.slice(
            -TerminalService.MAX_OUTPUT_BUFFER_SIZE
          );
        }
      }

      const listeners = this.outputListeners.get(terminalId);
      if (listeners) {
        for (const listener of listeners) {
          listener(data);
        }
      }
    });
    disposables.push(() => dataDisposable.dispose());

    // Set up exit listener
    const exitDisposable = pty.onExit(({ exitCode }: { exitCode: number }) => {
      logger.info('Terminal exited', { terminalId, exitCode });
      const listeners = this.exitListeners.get(terminalId);
      if (listeners) {
        for (const listener of listeners) {
          listener(exitCode);
        }
      }
      // Clean up (but not during forced cleanup - check if still tracked)
      if (this.terminals.get(workspaceId)?.has(terminalId)) {
        this.destroyTerminal(workspaceId, terminalId);
      }
    });
    disposables.push(() => exitDisposable.dispose());

    // Create terminal instance
    const instance: TerminalInstance = {
      id: terminalId,
      workspaceId,
      pty,
      cols,
      rows,
      createdAt: new Date(),
      disposables,
      outputBuffer: '',
    };

    // Store in workspace terminals map
    if (!this.terminals.has(workspaceId)) {
      this.terminals.set(workspaceId, new Map());
    }
    this.terminals.get(workspaceId)?.set(terminalId, instance);

    // Start resource monitoring if this is the first terminal
    this.ensureResourceMonitoring();

    logger.info('Terminal created', { terminalId, workspaceId, pid: pty.pid });

    return { terminalId, pid: pty.pid };
  }

  /**
   * Write data to a terminal
   */
  writeToTerminal(workspaceId: string, terminalId: string, data: string): boolean {
    const instance = this.getTerminal(workspaceId, terminalId);
    if (!instance) {
      logger.warn('Terminal not found for write', { workspaceId, terminalId });
      return false;
    }

    instance.pty.write(data);
    return true;
  }

  /**
   * Resize a terminal
   */
  resizeTerminal(workspaceId: string, terminalId: string, cols: number, rows: number): boolean {
    const instance = this.getTerminal(workspaceId, terminalId);
    if (!instance) {
      logger.warn('Terminal not found for resize', { workspaceId, terminalId });
      return false;
    }

    instance.pty.resize(cols, rows);
    instance.cols = cols;
    instance.rows = rows;

    logger.debug('Terminal resized', { terminalId, cols, rows });
    return true;
  }

  /**
   * Destroy a terminal instance
   */
  destroyTerminal(workspaceId: string, terminalId: string): boolean {
    const workspaceTerminals = this.terminals.get(workspaceId);
    if (!workspaceTerminals) {
      return false;
    }

    const instance = workspaceTerminals.get(terminalId);
    if (!instance) {
      return false;
    }

    // Remove from maps FIRST to prevent re-entry from exit handler
    workspaceTerminals.delete(terminalId);
    if (workspaceTerminals.size === 0) {
      this.terminals.delete(workspaceId);
    }

    // Clean up our listeners
    this.outputListeners.delete(terminalId);
    this.exitListeners.delete(terminalId);

    // Dispose PTY event listeners before killing
    for (const dispose of instance.disposables) {
      try {
        dispose();
      } catch {
        // Ignore disposal errors
      }
    }

    // Kill the PTY process
    try {
      instance.pty.kill();
    } catch (error) {
      logger.warn('Error killing terminal', { terminalId, error });
    }

    logger.info('Terminal destroyed', { terminalId, workspaceId });
    return true;
  }

  /**
   * Get a terminal instance
   */
  getTerminal(workspaceId: string, terminalId: string): TerminalInstance | null {
    const workspaceTerminals = this.terminals.get(workspaceId);
    if (!workspaceTerminals) {
      return null;
    }
    return workspaceTerminals.get(terminalId) || null;
  }

  /**
   * Get all terminals for a workspace
   */
  getTerminalsForWorkspace(workspaceId: string): TerminalInstance[] {
    const workspaceTerminals = this.terminals.get(workspaceId);
    if (!workspaceTerminals) {
      return [];
    }
    return Array.from(workspaceTerminals.values());
  }

  /**
   * Register an output listener for a terminal
   */
  onOutput(terminalId: string, listener: (data: string) => void): () => void {
    if (!this.outputListeners.has(terminalId)) {
      this.outputListeners.set(terminalId, new Set());
    }
    this.outputListeners.get(terminalId)?.add(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.outputListeners.get(terminalId);
      if (listeners) {
        listeners.delete(listener);
      }
    };
  }

  /**
   * Register an exit listener for a terminal
   */
  onExit(terminalId: string, listener: (exitCode: number) => void): () => void {
    if (!this.exitListeners.has(terminalId)) {
      this.exitListeners.set(terminalId, new Set());
    }
    this.exitListeners.get(terminalId)?.add(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.exitListeners.get(terminalId);
      if (listeners) {
        listeners.delete(listener);
      }
    };
  }

  /**
   * Destroy all terminals for a workspace
   */
  destroyWorkspaceTerminals(workspaceId: string): void {
    const workspaceTerminals = this.terminals.get(workspaceId);
    if (!workspaceTerminals) {
      return;
    }

    for (const terminalId of workspaceTerminals.keys()) {
      this.destroyTerminal(workspaceId, terminalId);
    }

    logger.info('All workspace terminals destroyed', { workspaceId });
  }

  /**
   * Clean up all terminals (for graceful shutdown)
   */
  cleanup(): void {
    this.stopResourceMonitoring();
    for (const workspaceId of this.terminals.keys()) {
      this.destroyWorkspaceTerminals(workspaceId);
    }
    logger.info('All terminals cleaned up');
  }

  /**
   * Get count of active terminals
   */
  getActiveTerminalCount(): number {
    let count = 0;
    for (const workspaceTerminals of this.terminals.values()) {
      count += workspaceTerminals.size;
    }
    return count;
  }

  /**
   * Get all active terminals for admin view
   */
  getAllTerminals(): Array<{
    id: string;
    workspaceId: string;
    pid: number;
    cols: number;
    rows: number;
    createdAt: Date;
    resourceUsage?: TerminalResourceUsage;
  }> {
    const terminals: Array<{
      id: string;
      workspaceId: string;
      pid: number;
      cols: number;
      rows: number;
      createdAt: Date;
      resourceUsage?: TerminalResourceUsage;
    }> = [];

    for (const workspaceTerminals of this.terminals.values()) {
      for (const instance of workspaceTerminals.values()) {
        terminals.push({
          id: instance.id,
          workspaceId: instance.workspaceId,
          pid: instance.pty.pid,
          cols: instance.cols,
          rows: instance.rows,
          createdAt: instance.createdAt,
          resourceUsage: instance.lastResourceUsage,
        });
      }
    }

    return terminals;
  }
}

// Export singleton instance
export const terminalService = new TerminalService();
