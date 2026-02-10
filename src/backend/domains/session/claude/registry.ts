/**
 * Instance-based process registry for Claude sessions.
 *
 * Eliminates the module-level Map (DOM-04) by encapsulating process tracking
 * within a class instance. Consumers that need a shared registry should create
 * or inject a single ProcessRegistry instance.
 */

import type { ProcessStatus, ResourceUsage } from './types/process-types';

/**
 * Interface for registered processes.
 * ClaudeProcess implements this implicitly.
 * Includes methods needed by sessionService for lifecycle management.
 */
export interface RegisteredProcess {
  getStatus(): ProcessStatus;
  isRunning(): boolean;
  getPid(): number | undefined;
  interrupt(): Promise<void>;
  getResourceUsage(): ResourceUsage | null;
  getIdleTimeMs(): number;
}

/**
 * Instance-based registry for active Claude processes.
 * Provides a single source of truth for process status queries.
 *
 * Processes auto-register on spawn and auto-unregister on exit,
 * so consumers don't need to manually track lifecycle.
 */
export class ProcessRegistry {
  private readonly processes = new Map<string, RegisteredProcess>();

  register(sessionId: string, process: RegisteredProcess): void {
    this.processes.set(sessionId, process);
  }

  unregister(sessionId: string): void {
    this.processes.delete(sessionId);
  }

  get(sessionId: string): RegisteredProcess | undefined {
    return this.processes.get(sessionId);
  }

  isProcessWorking(sessionId: string): boolean {
    const process = this.processes.get(sessionId);
    if (!process) {
      return false;
    }

    const status = process.getStatus();

    // Actively working states
    if (status === 'starting' || status === 'running') {
      return true;
    }

    // For 'ready' status, distinguish initial ready (startup) from idle ready (awaiting input)
    // Consider ready as "working" only if idle time is very short (< 2 seconds)
    // This prevents startup flickers while allowing idle sessions to show as WAITING
    if (status === 'ready') {
      const idleTimeMs = process.getIdleTimeMs();
      return idleTimeMs < 2000; // 2 second threshold
    }

    return false;
  }

  isAnyProcessWorking(sessionIds: string[]): boolean {
    return sessionIds.some((id) => this.isProcessWorking(id));
  }

  getAll(): Map<string, RegisteredProcess> {
    return new Map(this.processes);
  }
}

// Internal singleton for use within the claude/ subdirectory.
// External consumers should use their own ProcessRegistry instance.
export const processRegistry = new ProcessRegistry();
