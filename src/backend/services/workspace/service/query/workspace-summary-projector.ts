import type { WorkspaceDerivedState } from '@/backend/lib/workspace-derived-state';
import type { SessionSummary } from '@/shared/session-runtime';
import { type WorkspaceSummary } from '@/shared/workspace-summary';

type WorkspaceSummarySource = Omit<
  WorkspaceSummary<Date>,
  | keyof WorkspaceDerivedState
  | 'sessionSummaries'
  | 'pendingRequestType'
  | 'gitStats'
  | 'lastActivityAt'
>;

/** Return the canonical board/sidebar projection. */
export function projectWorkspaceSummary(
  w: WorkspaceSummarySource,
  fields: {
    sessionSummaries: SessionSummary[];
    pendingRequestType: WorkspaceSummary['pendingRequestType'];
    gitStats: WorkspaceSummary['gitStats'];
    lastActivityAt: string | null;
    derivedState: WorkspaceDerivedState;
  }
): WorkspaceSummary<Date> {
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    status: w.status,
    createdAt: w.createdAt,
    branchName: w.branchName,
    worktreePath: w.worktreePath,
    initErrorMessage: w.initErrorMessage,
    prs: w.prs,
    prSummary: w.prSummary,
    prUrl: w.prUrl,
    prNumber: w.prNumber,
    prState: w.prState,
    prCiStatus: w.prCiStatus,
    ratchetEnabled: w.ratchetEnabled,
    ratchetState: w.ratchetState,
    prMonitoring: w.prMonitoring,
    runScriptStatus: w.runScriptStatus,
    githubIssueNumber: w.githubIssueNumber,
    githubIssueUrl: w.githubIssueUrl,
    linearIssueId: w.linearIssueId,
    linearIssueIdentifier: w.linearIssueIdentifier,
    linearIssueUrl: w.linearIssueUrl,
    creationSource: w.creationSource,
    sessionSummaries: fields.sessionSummaries,
    pendingRequestType: fields.pendingRequestType,
    gitStats: fields.gitStats,
    lastActivityAt: fields.lastActivityAt,
    isWorking: fields.derivedState.isWorking,
    kanbanColumn: fields.derivedState.kanbanColumn,
    sidebarStatus: fields.derivedState.sidebarStatus,
    ratchetButtonAnimated: fields.derivedState.ratchetButtonAnimated,
    flowPhase: fields.derivedState.flowPhase,
    ciObservation: fields.derivedState.ciObservation,
    statusReason: fields.derivedState.statusReason,
  };
}
