import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

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
    mode: 'STANDARD',
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

/** The snapshot-backed half of a list row, shared with the detail cache. */
function projectSnapshotToLiveFields(entry: WorkspaceSnapshotEntry) {
  return {
    id: entry.workspaceId,
    projectId: entry.projectId,
    name: entry.name,
    status: entry.status,
    createdAt: new Date(entry.createdAt),
    branchName: entry.branchName,
    prUrl: entry.prUrl,
    prNumber: entry.prNumber,
    prState: entry.prState,
    prCiStatus: entry.prCiStatus,
    ratchetEnabled: entry.ratchetEnabled,
    ratchetState: entry.ratchetState,
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
  };
}

export function projectSnapshotToWorkspace(
  entry: WorkspaceSnapshotEntry,
  existing?: ProjectWorkspace
): ProjectWorkspace {
  return {
    ...mutationOnlyFieldDefaults(),
    ...existing,
    ...projectSnapshotToLiveFields(entry),
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

  return {
    ...existing,
    ...projectSnapshotToLiveFields(entry),
    prUpdatedAt: entry.prUpdatedAt ? new Date(entry.prUpdatedAt) : null,
    hasHadSessions: entry.hasHadSessions,
    ratchetDispatchOutcome: entry.ratchetDispatchOutcome,
    ratchetDispatchRetryCount: entry.ratchetDispatchRetryCount,
  };
}
