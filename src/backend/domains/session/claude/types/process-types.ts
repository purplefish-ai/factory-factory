/**
 * Shared types for Claude process management.
 * Extracted to avoid circular dependencies between process.ts and registry.ts.
 */

/**
 * Process lifecycle states.
 */
export type ProcessStatus = 'starting' | 'ready' | 'running' | 'exited';

/**
 * Resource usage snapshot for a process.
 */
export interface ResourceUsage {
  cpu: number;
  memory: number;
  timestamp: Date;
}
