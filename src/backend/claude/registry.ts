/**
 * Global registry for active Claude processes.
 * Provides a single source of truth for process status queries.
 *
 * Processes auto-register on spawn and auto-unregister on exit,
 * so consumers don't need to manually track lifecycle.
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

const activeProcesses = new Map<string, RegisteredProcess>();

export function registerProcess(sessionId: string, process: RegisteredProcess): void {
  activeProcesses.set(sessionId, process);
}

export function unregisterProcess(sessionId: string): void {
  activeProcesses.delete(sessionId);
}

export function getProcess(sessionId: string): RegisteredProcess | undefined {
  return activeProcesses.get(sessionId);
}

export function isProcessWorking(sessionId: string): boolean {
  const process = activeProcesses.get(sessionId);
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

export function isAnyProcessWorking(sessionIds: string[]): boolean {
  return sessionIds.some((id) => isProcessWorking(id));
}

export function getAllProcesses(): Map<string, RegisteredProcess> {
  return new Map(activeProcesses);
}
