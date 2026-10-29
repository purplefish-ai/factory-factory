import type { WorkspaceDerivedStateInput } from '@/backend/lib/workspace-derived-state';
import {
  findWorkspaceSessionRuntimeError,
  hasStartingSessionSummary,
  type SessionSummary,
} from '@/shared/session-runtime';

/** Normalized persisted fields shared by HTTP reads and accepted snapshot state. */
export interface WorkspaceDerivedStateSource extends Pick<
  WorkspaceDerivedStateInput,
  | 'prSummary'
  | 'prUrl'
  | 'prState'
  | 'prCiStatus'
  | 'ratchetState'
  | 'hasHadSessions'
  | 'ratchetEnabled'
  | 'hasMergeConflict'
  | 'prMonitoring'
> {
  status: WorkspaceDerivedStateInput['lifecycle'];
}

export interface WorkspaceDerivedRuntimeInput {
  sessionSummaries: SessionSummary[];
  /** Raw session activity, never an already-projected workspace isWorking. */
  sessionIsWorking: boolean;
  pendingRequestType: WorkspaceDerivedStateInput['pendingRequestType'];
  flowState: WorkspaceDerivedStateInput['flowState'];
}

/** Prepare derivation inputs without reading runtime state or changing raw values. */
export function toWorkspaceDerivedStateInput(
  source: WorkspaceDerivedStateSource,
  runtime: WorkspaceDerivedRuntimeInput
): WorkspaceDerivedStateInput {
  return {
    lifecycle: source.status,
    prSummary: source.prSummary,
    prUrl: source.prUrl,
    prState: source.prState,
    prCiStatus: source.prCiStatus,
    ratchetState: source.ratchetState,
    hasHadSessions: source.hasHadSessions,
    sessionIsWorking: runtime.sessionIsWorking,
    pendingRequestType: runtime.pendingRequestType,
    hasSessionRuntimeError: Boolean(findWorkspaceSessionRuntimeError(runtime.sessionSummaries)),
    isSessionStarting: hasStartingSessionSummary(runtime.sessionSummaries),
    ratchetEnabled: source.ratchetEnabled,
    hasMergeConflict: source.hasMergeConflict,
    dispatchStalled: Boolean(source.prMonitoring?.pauseReason),
    prMonitoring: source.prMonitoring,
    flowState: runtime.flowState,
  };
}

export interface WorkspaceActivitySource {
  agentSessions?: Array<{ updatedAt: Date }> | null;
  terminalSessions?: Array<{ updatedAt: Date }> | null;
}

/** Most recent valid agent or terminal update, in the snapshot wire format. */
export function deriveLastActivityAt(workspace: WorkspaceActivitySource): string | null {
  const sessionDates = [
    ...(workspace.agentSessions?.map((session) => session.updatedAt) ?? []),
    ...(workspace.terminalSessions?.map((session) => session.updatedAt) ?? []),
  ].filter((date) => Number.isFinite(date?.getTime()));

  if (sessionDates.length === 0) {
    return null;
  }

  return new Date(
    sessionDates.reduce((max, date) => Math.max(max, date.getTime()), -Infinity)
  ).toISOString();
}
