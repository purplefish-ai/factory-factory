import type { SessionStatus } from '@/shared/core';

export type SessionRuntimePhase =
  | 'loading'
  | 'starting'
  | 'running'
  | 'idle'
  | 'stopping'
  | 'error';

export type SessionRuntimeProcessState = 'unknown' | 'alive' | 'stopped';

export type SessionRuntimeActivity = 'WORKING' | 'IDLE';

export interface SessionRuntimeLastExit {
  code: number | null;
  timestamp: string;
  unexpected: boolean;
}

export interface SessionSummary {
  sessionId: string;
  name: string | null;
  workflow: string | null;
  model: string | null;
  provider?: 'CLAUDE' | 'CODEX';
  persistedStatus: SessionStatus;
  runtimePhase: SessionRuntimePhase;
  processState: SessionRuntimeProcessState;
  activity: SessionRuntimeActivity;
  updatedAt: string;
  lastExit: SessionRuntimeLastExit | null;
  errorMessage?: string | null;
}

export interface SessionRuntimeState {
  phase: SessionRuntimePhase;
  processState: SessionRuntimeProcessState;
  lastExit?: SessionRuntimeLastExit;
  errorMessage?: string;
  activity: SessionRuntimeActivity;
  updatedAt: string;
}

export function createInitialSessionRuntimeState(): SessionRuntimeState {
  return {
    phase: 'idle',
    processState: 'stopped',
    activity: 'IDLE',
    updatedAt: new Date().toISOString(),
  };
}

function formatUnexpectedExitMessage(lastExit: SessionRuntimeLastExit): string {
  return `Exited unexpectedly${lastExit.code !== null ? ` (code ${lastExit.code})` : ''}`;
}

export function getSessionSummaryErrorMessage(
  summary: Pick<SessionSummary, 'runtimePhase' | 'errorMessage' | 'lastExit'>
): string | null {
  const trimmedError = summary.errorMessage?.trim();

  if (summary.runtimePhase === 'error') {
    if (trimmedError) {
      return trimmedError;
    }
    if (summary.lastExit?.unexpected) {
      return formatUnexpectedExitMessage(summary.lastExit);
    }
    return 'Session entered an error state';
  }

  if (summary.lastExit?.unexpected) {
    return trimmedError || formatUnexpectedExitMessage(summary.lastExit);
  }

  return null;
}

export function getSessionRuntimeErrorMessage(
  runtime: Pick<SessionRuntimeState, 'phase' | 'errorMessage' | 'lastExit'>
): string | null {
  const trimmedError = runtime.errorMessage?.trim();

  if (runtime.phase === 'error') {
    if (trimmedError) {
      return trimmedError;
    }
    if (runtime.lastExit?.unexpected) {
      return formatUnexpectedExitMessage(runtime.lastExit);
    }
    return 'Session entered an error state';
  }

  if (runtime.lastExit?.unexpected) {
    return trimmedError || formatUnexpectedExitMessage(runtime.lastExit);
  }

  return null;
}

export function findWorkspaceSessionRuntimeError(
  summaries: SessionSummary[] | undefined
): { sessionId: string; message: string } | null {
  if (!summaries || summaries.length === 0) {
    return null;
  }

  for (const summary of summaries) {
    const message = getSessionSummaryErrorMessage(summary);
    if (message) {
      return {
        sessionId: summary.sessionId,
        message,
      };
    }
  }

  return null;
}
