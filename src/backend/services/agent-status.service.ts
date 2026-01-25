/**
 * Agent Status Service
 *
 * Provides an abstraction layer for querying agent process status.
 * This allows services to check if agents are running without importing
 * from the agent layer directly, maintaining proper layer separation.
 *
 * The process-adapter registers its status methods at startup, and
 * services call the exported functions to query status.
 *
 * Error Handling:
 * - isAgentRunning() throws if provider not registered, as this indicates
 *   a startup timing bug that should fail fast (reconciliation depends on it)
 * - getAgentClaudeSessionId() returns null if provider not registered, as
 *   crash recovery already handles null gracefully and this is non-critical
 */

type StatusChecker = (agentId: string) => boolean;
type SessionGetter = (agentId: string) => string | null;

let isRunningFn: StatusChecker | null = null;
let getSessionFn: SessionGetter | null = null;

/**
 * Register the agent status provider callbacks.
 * Called by process-adapter at initialization.
 */
export function registerAgentStatusProvider(
  isRunning: StatusChecker,
  getClaudeSessionId: SessionGetter
): void {
  isRunningFn = isRunning;
  getSessionFn = getClaudeSessionId;
}

/**
 * Check if an agent process is currently running.
 * @throws Error if provider not registered (startup timing issue)
 */
export function isAgentRunning(agentId: string): boolean {
  if (!isRunningFn) {
    throw new Error('Agent status provider not registered');
  }
  return isRunningFn(agentId);
}

/**
 * Get the Claude session ID for an agent (for crash recovery).
 * Returns null if provider not registered or agent has no session.
 */
export function getAgentClaudeSessionId(agentId: string): string | null {
  if (!getSessionFn) {
    return null;
  }
  return getSessionFn(agentId);
}
