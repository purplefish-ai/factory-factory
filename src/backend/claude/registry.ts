/**
 * @deprecated Import from '@/backend/domains/session/claude/registry' instead.
 * This backward-compatible shim will be removed in Phase 9 (Import Rewiring).
 */
import { ProcessRegistry } from '@/backend/domains/session/claude/registry';

export type { RegisteredProcess } from '@/backend/domains/session/claude/registry';

// Singleton instance for backward compatibility with free-function API
const registry = new ProcessRegistry();

export function registerProcess(
  sessionId: string,
  process: import('@/backend/domains/session/claude/registry').RegisteredProcess
): void {
  registry.register(sessionId, process);
}

export function unregisterProcess(sessionId: string): void {
  registry.unregister(sessionId);
}

export function getProcess(
  sessionId: string
): import('@/backend/domains/session/claude/registry').RegisteredProcess | undefined {
  return registry.get(sessionId);
}

export function isProcessWorking(sessionId: string): boolean {
  return registry.isProcessWorking(sessionId);
}

export function isAnyProcessWorking(sessionIds: string[]): boolean {
  return registry.isAnyProcessWorking(sessionIds);
}

export function getAllProcesses(): Map<
  string,
  import('@/backend/domains/session/claude/registry').RegisteredProcess
> {
  return registry.getAll();
}
