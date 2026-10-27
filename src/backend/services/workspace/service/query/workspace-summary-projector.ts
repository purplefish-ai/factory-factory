import type { WorkspaceDerivedState } from '@/backend/lib/workspace-derived-state';
import type { SessionSummary } from '@/shared/session-runtime';
import { projectAutoIterationSummary, type WorkspaceSummary } from '@/shared/workspace-summary';

type WorkspaceSummarySource = Omit<
  WorkspaceSummary<Date>,
  | keyof WorkspaceDerivedState
  | 'sessionSummaries'
  | 'pendingRequestType'
  | 'gitStats'
  | 'lastActivityAt'
  | 'autoIteration'
>;

/** Preserve legacy raw loop fields while returning the canonical board/sidebar projection. */
export function projectWorkspaceSummary<TConfig, TProgress>(
  w: WorkspaceSummarySource & {
    autoIterationConfig: TConfig;
    autoIterationProgress: TProgress;
  },
  fields: {
    sessionSummaries: SessionSummary[];
    pendingRequestType: WorkspaceSummary['pendingRequestType'];
    gitStats: WorkspaceSummary['gitStats'];
    lastActivityAt: string | null;
    derivedState: WorkspaceDerivedState;
  }
): WorkspaceSummary<Date> & { autoIterationConfig: TConfig; autoIterationProgress: TProgress } {
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    status: w.status,
    createdAt: w.createdAt,
    branchName: w.branchName,
    worktreePath: w.worktreePath,
    initErrorMessage: w.initErrorMessage,
    mode: w.mode,
    autoIterationStatus: w.autoIterationStatus,
    autoIteration: projectAutoIterationSummary(w),
    autoIterationConfig: w.autoIterationConfig,
    autoIterationProgress: w.autoIterationProgress,
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
