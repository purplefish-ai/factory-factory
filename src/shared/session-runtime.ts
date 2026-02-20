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

function resolveSessionRuntimeErrorMessage(
  phase: SessionRuntimePhase,
  errorMessage: string | null | undefined,
  lastExit: SessionRuntimeLastExit | null | undefined
): string | null {
  const trimmedError = errorMessage?.trim();

  if (phase === 'error') {
    if (trimmedError) {
      return trimmedError;
    }
    if (lastExit?.unexpected) {
      return formatUnexpectedExitMessage(lastExit);
    }
    return 'Session entered an error state';
  }

  if (lastExit?.unexpected) {
    return trimmedError || formatUnexpectedExitMessage(lastExit);
  }

  return null;
}

export function getSessionSummaryErrorMessage(
  summary: Pick<SessionSummary, 'runtimePhase' | 'errorMessage' | 'lastExit'>
): string | null {
  return resolveSessionRuntimeErrorMessage(
    summary.runtimePhase,
    summary.errorMessage,
    summary.lastExit
  );
}

export function getSessionRuntimeErrorMessage(
  runtime: Pick<SessionRuntimeState, 'phase' | 'errorMessage' | 'lastExit'>
): string | null {
  return resolveSessionRuntimeErrorMessage(runtime.phase, runtime.errorMessage, runtime.lastExit);
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
