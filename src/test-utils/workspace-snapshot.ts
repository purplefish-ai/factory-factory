import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

export function makeWorkspaceSnapshotEntry(
  overrides: Partial<WorkspaceSnapshotEntry> = {}
): WorkspaceSnapshotEntry {
  return {
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
    ratchetEnabled: false,
    ratchetState: 'IDLE',
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
}
