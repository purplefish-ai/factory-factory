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
}

export interface SessionRuntimeState {
  phase: SessionRuntimePhase;
  processState: SessionRuntimeProcessState;
  lastExit?: SessionRuntimeLastExit;
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
