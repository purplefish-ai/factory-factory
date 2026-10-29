import { deriveWorkspacePRSummary } from '@/shared/workspace-pr-summary';
import {
  WorkspaceSnapshotEntrySchema,
  type WorkspaceSnapshotEntry,
} from '@/shared/workspace-snapshot';

export function makeWorkspaceSnapshotEntry(
  overrides: Partial<WorkspaceSnapshotEntry> = {}
): WorkspaceSnapshotEntry {
  const entry: Omit<WorkspaceSnapshotEntry, 'summaryVersion'> & { summaryVersion?: 1 } = {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    version: 1,
    computedAt: '2026-01-15T10:00:00Z',
    source: 'test',
    name: 'test-workspace',
    status: 'READY',
    createdAt: '2026-01-10T08:00:00Z',
    branchName: 'feat/test',
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    hasMergeConflict: false,
    ratchetEnabled: false,
    ratchetState: 'IDLE',
    prMonitoring: {
      deliveryMode: 'MAIN',
      enabled: false,
      recipientSessionId: null,
      bindingRevision: 0,
      pauseReason: null,
      pendingEventCount: 0,
    },
    runScriptStatus: 'IDLE',
    hasHadSessions: false,
    isWorking: false,
    pendingRequestType: null,
    sessionSummaries: [],
    gitStats: null,
    lastActivityAt: null,
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    kanbanColumn: 'WORKING',
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    ratchetButtonAnimated: false,
    statusReason: {
      code: 'NO_SESSION_STARTED',
      label: 'No session started',
      tone: 'neutral',
      needsUser: true,
    },
    fieldTimestamps: {
      workspace: 1000,
      pr: 0,
      session: 0,
      ratchet: 0,
      runScript: 0,
      reconciliation: 0,
    },
    ...overrides,
  };
  const { summaryVersion, ...legacy } = entry;
  return summaryVersion === 1 ? WorkspaceSnapshotEntrySchema.parse(entry) : legacy;
}

/** A complete wire fixture with explicit nullable metadata and compact loop state. */
export function makeCompleteWorkspaceSnapshotEntry(
  overrides: Partial<WorkspaceSnapshotEntry> = {}
) {
  return makeWorkspaceSnapshotEntry({
    summaryVersion: 1,
    worktreePath: '/worktrees/live',
    initErrorMessage: null,
    githubIssueNumber: 42,
    githubIssueUrl: 'https://github.com/org/repo/issues/42',
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    creationSource: 'GITHUB_ISSUE',
    prs: overrides.prs ?? [],
    prSummary: deriveWorkspacePRSummary(overrides.prs ?? [], overrides.ratchetEnabled ?? false),
    ...overrides,
  });
}
