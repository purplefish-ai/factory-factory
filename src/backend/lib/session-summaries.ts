import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import {
  getPendingRequestType,
  type PendingRequestClassificationInput,
} from '@/shared/pending-request-types';
import {
  hasWorkingSessionSummary as hasWorkingRuntimeSessionSummary,
  isSessionSummaryWorking as isRuntimeSessionSummaryWorking,
  type SessionRuntimeState,
  type SessionSummary,
} from '@/shared/session-runtime';

interface SessionLike {
  id: string;
  name: string | null;
  workflow: string | null;
  model: string | null;
  provider?: 'CLAUDE' | 'CODEX';
  codexAccountId?: string | null;
  status: DbSessionStatus;
}

/**
 * Builds the tab/board session summaries. `pendingRequests` is the live
 * session-id → pending interactive request map (`getAllPendingRequests()`), so
 * each summary says whether that session is blocked on the user.
 */
export function buildWorkspaceSessionSummaries(
  sessions: SessionLike[],
  getRuntimeSnapshot: (sessionId: string) => SessionRuntimeState,
  pendingRequests: ReadonlyMap<string, PendingRequestClassificationInput>
): SessionSummary[] {
  return sessions.map((session) => {
    const runtime = getRuntimeSnapshot(session.id);
    const pendingRequest = pendingRequests.get(session.id);
    return {
      sessionId: session.id,
      name: session.name,
      workflow: session.workflow,
      model: session.model,
      provider: session.provider,
      ...(session.codexAccountId !== undefined ? { codexAccountId: session.codexAccountId } : {}),
      persistedStatus: session.status,
      runtimePhase: runtime.phase,
      processState: runtime.processState,
      activity: runtime.activity,
      updatedAt: runtime.updatedAt,
      lastExit: runtime.lastExit ?? null,
      errorMessage: runtime.errorMessage ?? null,
      pendingRequestType: pendingRequest ? getPendingRequestType(pendingRequest) : null,
    };
  });
}

export function isSessionSummaryWorking(summary: SessionSummary): boolean {
  return isRuntimeSessionSummaryWorking(summary);
}

export function hasWorkingSessionSummary(summaries: SessionSummary[]): boolean {
  return hasWorkingRuntimeSessionSummary(summaries);
}
