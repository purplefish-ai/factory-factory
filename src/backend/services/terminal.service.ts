/**
 * Terminal Service
 *
 * Manages PTY (pseudo-terminal) instances for workspaces using node-pty.
 * Each workspace can have multiple terminal sessions that persist across
 * WebSocket reconnections.
 */

import type { IPty } from 'node-pty';
import { createLogger } from './logger.service.js';

const logger = createLogger('terminal');

// =============================================================================
// Types
// =============================================================================

export interface TerminalInstance {
  id: string;
  workspaceId: string;
  pty: IPty;
  cols: number;
  rows: number;
  createdAt: Date;
  // Disposables for cleaning up event listeners
  disposables: (() => void)[];
}

export interface CreateTerminalOptions {
  workspaceId: string;
  workingDir: string;
  cols?: number;
  rows?: number;
  shell?: string;
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
  async createTerminal(options: CreateTerminalOptions): Promise<string> {
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

    // Set up output listener
    const dataDisposable = pty.onData((data: string) => {
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
    };

    // Store in workspace terminals map
    if (!this.terminals.has(workspaceId)) {
      this.terminals.set(workspaceId, new Map());
    }
    this.terminals.get(workspaceId)?.set(terminalId, instance);

    logger.info('Terminal created', { terminalId, workspaceId, pid: pty.pid });

    return terminalId;
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
}

// Export singleton instance
export const terminalService = new TerminalService();
