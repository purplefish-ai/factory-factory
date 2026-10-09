import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';
import { kanbanColumnForStatusReason } from '@/shared/kanban-column-projection';
import {
  findWorkspaceSessionRuntimeError,
  hasStartingSessionSummary,
} from '@/shared/session-runtime';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';
import { deriveWorkspaceStatusReason } from '@/shared/workspace-status-reason';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** One row of the project workspace list — what the sidebar and the board render. */
export type ProjectWorkspace = RouterOutputs['workspace']['listForProject']['workspaces'][number];
export type WorkspaceDetail = RouterOutputs['workspace']['get'];

/**
 * Fields a snapshot entry doesn't carry, because they change through explicit
 * mutations rather than live workspace activity.
 *
 * An existing cache row supplies them; these defaults only apply to a
 * workspace a snapshot introduces before any fetch has returned it.
 */
function mutationOnlyFieldDefaults() {
  return {
    initErrorMessage: null,
    worktreePath: null,
    autoIterationStatus: null,
    autoIterationConfig: null,
    autoIterationProgress: null,
    githubIssueNumber: null,
    githubIssueUrl: null,
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    creationSource: 'MANUAL',
  } as const;
}

/** Legacy events lack a collection; merge their observation into cached associations. */
function projectSnapshotPRs(
  entry: WorkspaceSnapshotEntry,
  cachedPRs: readonly WorkspacePullRequest[]
): WorkspacePullRequest[] {
  if (entry.prs?.length || !entry.prUrl) {
    return entry.prs ?? [];
  }
  const cachedPR = cachedPRs.find((pr) => pr.url === entry.prUrl);
  const legacyId = `legacy-pr-${entry.workspaceId}`;
  const fallbackId = cachedPRs.some((pr) => pr.id === legacyId)
    ? `${legacyId}-${entry.prUrl}`
    : legacyId;
  const legacyPR: WorkspacePullRequest = {
    id: cachedPR?.id ?? fallbackId,
    url: entry.prUrl,
    number: entry.prNumber,
    title: cachedPR?.title ?? null,
    headRefName: cachedPR?.headRefName ?? null,
    baseRefName: cachedPR?.baseRefName ?? null,
    state: entry.prState,
    reviewState:
      entry.prState === 'DRAFT'
        ? (cachedPR?.reviewState ?? null)
        : entry.prState === 'CHANGES_REQUESTED' || entry.prState === 'APPROVED'
          ? entry.prState
          : null,
    ciStatus: entry.prCiStatus,
    hasMergeConflict: entry.hasMergeConflict,
    syncedAt: entry.prUpdatedAt,
  };
  return cachedPR
    ? cachedPRs.map((pr) => (pr.id === cachedPR.id ? legacyPR : pr))
    : [...cachedPRs, legacyPR];
}

function projectLegacyPRState(entry: WorkspaceSnapshotEntry, prs: WorkspacePullRequest[]) {
  const prSummary = deriveWorkspacePRSummary(prs, entry.ratchetEnabled);
  const solePR = prs.length === 1 ? prs[0] : undefined;
  const prState = solePR?.state ?? prSummary.state;
  const prCiStatus = solePR?.ciStatus ?? prSummary.ciStatus;
  const prUrl = solePR?.url ?? null;
  const prNumber = solePR?.number ?? null;
  const ratchetState = prSummary.ratchetState;
  const flow = deriveWorkspaceFlowState({
    prSummary,
    prUrl,
    prState,
    prCiStatus,
    ratchetState,
    prUpdatedAt: entry.prUpdatedAt ? new Date(entry.prUpdatedAt) : null,
    ratchetEnabled: entry.ratchetEnabled,
  });
  const statusReason = deriveWorkspaceStatusReason({
    lifecycle: entry.status,
    hasHadSessions: entry.hasHadSessions,
    isWorking: entry.isWorking,
    isSessionStarting:
      entry.statusReason.code === 'STARTING_SESSION' ||
      hasStartingSessionSummary(entry.sessionSummaries),
    pendingRequestType: entry.pendingRequestType,
    hasSessionRuntimeError:
      entry.statusReason.code === 'SESSION_ERROR' ||
      Boolean(findWorkspaceSessionRuntimeError(entry.sessionSummaries)),
    flowPhase: flow.phase,
    ciObservation: flow.ciObservation,
    prState,
    prCiStatus,
    ratchetState,
    ratchetEnabled: entry.ratchetEnabled,
    hasMergeConflict: prSummary.hasMergeConflict,
    dispatchStalled: false,
    prMonitoring: entry.prMonitoring,
    mode: entry.mode,
    autoIterationStatus: entry.autoIterationStatus,
  });
  return {
    prSummary,
    prUrl,
    prNumber,
    prState,
    prCiStatus,
    ratchetState,
    flowPhase: flow.phase,
    ciObservation: flow.ciObservation,
    ratchetButtonAnimated: flow.shouldAnimateRatchetButton,
    statusReason,
    kanbanColumn: kanbanColumnForStatusReason(statusReason.code),
    sidebarStatus: deriveWorkspaceSidebarStatus({
      isWorking: entry.isWorking,
      prSummary,
      prUrl,
      prState,
      prCiStatus,
      ratchetState,
    }),
  };
}

/** The snapshot-backed half of a list row, shared with the detail cache. */
function projectSnapshotToLiveFields(
  entry: WorkspaceSnapshotEntry,
  existing?: Pick<ProjectWorkspace, 'prs'>
) {
  const hasLegacyPR = !entry.prs?.length && Boolean(entry.prUrl);
  const prs = projectSnapshotPRs(entry, existing?.prs ?? []);
  return {
    id: entry.workspaceId,
    projectId: entry.projectId,
    name: entry.name,
    status: entry.status,
    mode: entry.mode,
    createdAt: new Date(entry.createdAt),
    branchName: entry.branchName,
    prs,
    prSummary: entry.prSummary ?? deriveWorkspacePRSummary(prs, entry.ratchetEnabled),
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
    prMonitoring: entry.prMonitoring,
    runScriptStatus: entry.runScriptStatus,
    sessionSummaries: entry.sessionSummaries,
    pendingRequestType: entry.pendingRequestType,
    isWorking: entry.isWorking,
    kanbanColumn: entry.kanbanColumn,
    sidebarStatus: entry.sidebarStatus,
    ratchetButtonAnimated: entry.ratchetButtonAnimated,
    flowPhase: entry.flowPhase,
    ciObservation: entry.ciObservation,
    statusReason: entry.statusReason,
    ...(hasLegacyPR ? projectLegacyPRState(entry, prs) : {}),
  };
}

export function projectSnapshotToWorkspace(
  entry: WorkspaceSnapshotEntry,
  existing?: ProjectWorkspace
): ProjectWorkspace {
  return {
    ...mutationOnlyFieldDefaults(),
    ...existing,
    ...projectSnapshotToLiveFields(entry, existing),
    gitStats: entry.gitStats,
    lastActivityAt: entry.lastActivityAt,
  };
}

export function mergeProjectSnapshotIntoWorkspaceDetail(
  entry: WorkspaceSnapshotEntry,
  existing: WorkspaceDetail | undefined
): WorkspaceDetail | undefined {
  if (!existing) {
    return undefined;
  }

  const liveFields = projectSnapshotToLiveFields(entry, existing);
  const hasLegacyPR = !entry.prs?.length && Boolean(entry.prUrl);
  return {
    ...existing,
    ...liveFields,
    prHasMergeConflict: hasLegacyPR
      ? liveFields.prSummary.hasMergeConflict
      : entry.hasMergeConflict,
    prUpdatedAt: entry.prUpdatedAt ? new Date(entry.prUpdatedAt) : null,
    hasHadSessions: entry.hasHadSessions,
  };
}
