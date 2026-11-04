import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import { sessionUiStatusKindFromSummary } from '@/shared/session-runtime';
import type { WorkspaceSessionRuntimeSummary } from './session-tab-runtime';

/**
 * Unsent queued messages, tagged with the session they belong to. The chat
 * reducer keeps the previous session's queue during a switch until the new
 * session hydrates, so an untagged count could be charged to the wrong tab.
 */
export interface SessionQueuedMessageCount {
  sessionId: string;
  count: number;
}

/** Work that closing a session tab would interrupt or discard. */
export interface SessionCloseRisk {
  running: boolean;
  queuedMessageCount: number;
}

interface SessionCloseRiskInput {
  summary?: WorkspaceSessionRuntimeSummary;
  persistedStatus?: DbSessionStatus;
  queuedMessageCount?: number;
}

function isSessionActive(
  summary: WorkspaceSessionRuntimeSummary | undefined,
  persistedStatus: DbSessionStatus | undefined
): boolean {
  if (!summary) {
    return persistedStatus === 'RUNNING';
  }
  const kind = sessionUiStatusKindFromSummary(summary);
  return kind === 'working' || kind === 'starting';
}

/**
 * Returns what closing the session would lose, or null when it is idle and can
 * close immediately. Closing stops the agent and deletes the live session, so
 * a running agent or unsent queued messages warrant confirmation.
 */
export function getSessionCloseRisk({
  summary,
  persistedStatus,
  queuedMessageCount = 0,
}: SessionCloseRiskInput): SessionCloseRisk | null {
  const running = isSessionActive(summary, persistedStatus);
  if (!running && queuedMessageCount <= 0) {
    return null;
  }
  return { running, queuedMessageCount: Math.max(0, queuedMessageCount) };
}

function formatQueuedMessages(count: number): string {
  return `${count} queued message${count === 1 ? '' : 's'}`;
}

export function describeSessionCloseRisk(
  label: string,
  risk: SessionCloseRisk
): { title: string; description: string; confirmText: string } {
  const outcome =
    risk.queuedMessageCount > 0
      ? 'its transcript moves to Closed sessions. You can read it there; discarded queued messages cannot be recovered.'
      : 'its transcript moves to Closed sessions. You can read it there.';
  const queued = formatQueuedMessages(risk.queuedMessageCount);
  if (risk.running && risk.queuedMessageCount > 0) {
    return {
      title: `Stop and close ${label}?`,
      description: `${label} is still working and has ${queued}. Closing the tab stops the agent, discards the queued messages, and ${outcome}`,
      confirmText: 'Stop and close',
    };
  }
  if (risk.running) {
    return {
      title: `Stop and close ${label}?`,
      description: `${label} is still working. Closing the tab stops the agent and ${outcome}`,
      confirmText: 'Stop and close',
    };
  }
  return {
    title: `Discard and close ${label}?`,
    description: `${label} has ${queued} that ${risk.queuedMessageCount === 1 ? 'has' : 'have'} not been sent. Closing the tab discards ${risk.queuedMessageCount === 1 ? 'it' : 'them'} and ${outcome}`,
    confirmText: 'Discard and close',
  };
}
