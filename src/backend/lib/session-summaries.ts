import type { WorkspaceSessionSummary } from '@/backend/services/workspace-snapshot-store.service';
import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import type { SessionRuntimeState } from '@/shared/session-runtime';

interface SessionLike {
  id: string;
  name: string | null;
  workflow: string | null;
  model: string | null;
  provider?: 'CLAUDE' | 'CODEX' | 'OPENCODE';
  status: DbSessionStatus;
}

export function buildWorkspaceSessionSummaries(
  sessions: SessionLike[],
  getRuntimeSnapshot: (sessionId: string) => SessionRuntimeState
): WorkspaceSessionSummary[] {
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

export function isSessionSummaryWorking(summary: WorkspaceSessionSummary): boolean {
  return summary.activity === 'WORKING' || summary.runtimePhase === 'running';
}

export function hasWorkingSessionSummary(summaries: WorkspaceSessionSummary[]): boolean {
  return summaries.some((summary) => isSessionSummaryWorking(summary));
}
