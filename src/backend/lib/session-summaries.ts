import type { SessionStatus as DbSessionStatus } from '@/shared/core';
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
  status: DbSessionStatus;
}

export function buildWorkspaceSessionSummaries(
  sessions: SessionLike[],
  getRuntimeSnapshot: (sessionId: string) => SessionRuntimeState
): SessionSummary[] {
  return sessions.map((session) => {
    const runtime = getRuntimeSnapshot(session.id);
    return {
      sessionId: session.id,
      name: session.name,
      workflow: session.workflow,
      model: session.model,
      provider: session.provider,
      persistedStatus: session.status,
      runtimePhase: runtime.phase,
      processState: runtime.processState,
      activity: runtime.activity,
      updatedAt: runtime.updatedAt,
      lastExit: runtime.lastExit ?? null,
      errorMessage: runtime.errorMessage ?? null,
    };
  });
}

export function isSessionSummaryWorking(summary: SessionSummary): boolean {
  return isRuntimeSessionSummaryWorking(summary);
}

export function hasWorkingSessionSummary(summaries: SessionSummary[]): boolean {
  return hasWorkingRuntimeSessionSummary(summaries);
}
