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
  const status = process?.getStatus();
  // Consider starting, ready, and running as "working" states
  // This prevents brief WAITING flickers when sessions are starting up
  return status === 'starting' || status === 'ready' || status === 'running';
}

export function isAnyProcessWorking(sessionIds: string[]): boolean {
  return sessionIds.some((id) => isProcessWorking(id));
}

export function getAllProcesses(): Map<string, RegisteredProcess> {
  return new Map(activeProcesses);
}
