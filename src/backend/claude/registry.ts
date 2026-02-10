/**
 * @deprecated Import from '@/backend/domains/session/claude/registry' instead.
 * This backward-compatible shim will be removed in Phase 9 (Import Rewiring).
 */
import { processRegistry } from '@/backend/domains/session/claude/registry';

export type { RegisteredProcess } from '@/backend/domains/session/claude/registry';
export { ProcessRegistry, processRegistry } from '@/backend/domains/session/claude/registry';

// Backward-compatible free-function API using the shared singleton.
export function registerProcess(
  sessionId: string,
  process: import('@/backend/domains/session/claude/registry').RegisteredProcess
): void {
  processRegistry.register(sessionId, process);
}

export function unregisterProcess(sessionId: string): void {
  processRegistry.unregister(sessionId);
}

export function getProcess(
  sessionId: string
): import('@/backend/domains/session/claude/registry').RegisteredProcess | undefined {
  return processRegistry.get(sessionId);
}

export function isProcessWorking(sessionId: string): boolean {
  return processRegistry.isProcessWorking(sessionId);
}

export function isAnyProcessWorking(sessionIds: string[]): boolean {
  return processRegistry.isAnyProcessWorking(sessionIds);
}

export function getAllProcesses(): Map<
  string,
  import('@/backend/domains/session/claude/registry').RegisteredProcess
> {
  return processRegistry.getAll();
}
