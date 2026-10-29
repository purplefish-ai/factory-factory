import type { SnapshotUpdateInput } from '@/backend/services/workspace';
import type { SnapshotFieldGroup } from '@/shared/workspace-snapshot';

// Independent expectations: adding a raw input requires an explicit grouping,
// hydration requirement, drift decision, and values below. No production field
// array or schema supplies the inventory, so an unclassified addition fails tsc.
type FieldPolicy = {
  group: SnapshotFieldGroup | 'name' | 'branch' | 'provenance';
  required: boolean;
  drift: SnapshotFieldGroup | 'name' | 'branch' | { excluded: string };
};
export const snapshotFieldPolicy = {
  projectId: {
    group: 'workspace',
    required: true,
    drift: { excluded: 'identity/index ownership' },
  },
  name: { group: 'name', required: true, drift: 'name' },
  nameUpdatedAt: {
    group: 'provenance',
    required: false,
    drift: { excluded: 'private name fence' },
  },
  status: { group: 'workspace', required: true, drift: 'workspace' },
  createdAt: { group: 'workspace', required: true, drift: { excluded: 'immutable creation time' } },
  branchName: { group: 'branch', required: true, drift: 'branch' },
  branchUpdatedAt: {
    group: 'provenance',
    required: false,
    drift: { excluded: 'private branch fence' },
  },
  hasHadSessions: {
    group: 'workspace',
    required: true,
    drift: { excluded: 'session history input' },
  },
  prs: { group: 'pr', required: true, drift: 'pr' },
  prSummary: { group: 'pr', required: true, drift: 'pr' },
  prUrl: {
    group: 'pr',
    required: true,
    drift: { excluded: 'legacy PR link; collection is compared' },
  },
  prNumber: { group: 'pr', required: true, drift: 'pr' },
  prState: { group: 'pr', required: true, drift: 'pr' },
  prCiStatus: { group: 'pr', required: true, drift: 'pr' },
  prUpdatedAt: { group: 'pr', required: true, drift: { excluded: 'volatile PR observation time' } },
  hasMergeConflict: {
    group: 'pr',
    required: true,
    drift: { excluded: 'legacy flag; PR summary is compared' },
  },
  isWorking: { group: 'session', required: true, drift: 'session' },
  pendingRequestType: { group: 'session', required: true, drift: 'session' },
  sessionSummaries: { group: 'session', required: true, drift: 'session' },
  ratchetEnabled: { group: 'ratchet', required: true, drift: 'ratchet' },
  ratchetState: { group: 'ratchet', required: true, drift: 'ratchet' },
  prMonitoring: { group: 'ratchet', required: true, drift: 'ratchet' },
  runScriptStatus: { group: 'runScript', required: true, drift: 'runScript' },
  gitStats: {
    group: 'git',
    required: false,
    drift: { excluded: 'separately refreshed Git cache' },
  },
  lastActivityAt: {
    group: 'reconciliation',
    required: true,
    drift: { excluded: 'volatile activity time' },
  },
  worktreePath: { group: 'metadata', required: true, drift: 'metadata' },
  initErrorMessage: { group: 'metadata', required: true, drift: 'metadata' },
  githubIssueNumber: { group: 'metadata', required: true, drift: 'metadata' },
  githubIssueUrl: { group: 'metadata', required: true, drift: 'metadata' },
  linearIssueId: { group: 'metadata', required: true, drift: 'metadata' },
  linearIssueIdentifier: { group: 'metadata', required: true, drift: 'metadata' },
  linearIssueUrl: { group: 'metadata', required: true, drift: 'metadata' },
  creationSource: { group: 'metadata', required: true, drift: 'metadata' },
} as const satisfies Record<keyof SnapshotUpdateInput, FieldPolicy>;

export const snapshotClockDefaults = {
  workspace: 0,
  pr: 0,
  session: 0,
  ratchet: 0,
  runScript: 0,
  reconciliation: 0,
  git: 0,
  metadata: 0,
} satisfies Record<SnapshotFieldGroup, number>;

export function authoritativeSnapshotInput(): Required<SnapshotUpdateInput> {
  return {
    projectId: 'project',
    name: 'Workspace',
    nameUpdatedAt: 100,
    branchUpdatedAt: 100,
    status: 'READY',
    createdAt: '2026-01-01T00:00:00.000Z',
    branchName: 'feature',
    hasHadSessions: false,
    prs: [],
    prSummary: {
      totalCount: 0,
      openCount: 0,
      hasNonterminal: false,
      state: 'NONE',
      ciStatus: 'UNKNOWN',
      hasMergeConflict: false,
      ratchetState: 'IDLE',
    },
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    hasMergeConflict: false,
    isWorking: false,
    pendingRequestType: null,
    sessionSummaries: [],
    ratchetEnabled: false,
    ratchetState: 'IDLE',
    prMonitoring: {
      enabled: false,
      deliveryMode: 'MAIN',
      recipientSessionId: null,
      bindingRevision: 0,
      pauseReason: null,
      pendingEventCount: 0,
    },
    runScriptStatus: 'IDLE',
    gitStats: null,
    lastActivityAt: null,
    worktreePath: null,
    initErrorMessage: null,
    githubIssueNumber: null,
    githubIssueUrl: null,
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    creationSource: 'MANUAL',
  };
}

export function changedSnapshotInput(): Required<SnapshotUpdateInput> {
  return {
    projectId: 'other-project',
    name: 'Renamed',
    nameUpdatedAt: 200,
    branchUpdatedAt: 200,
    status: 'FAILED',
    createdAt: '2026-02-01T00:00:00.000Z',
    branchName: 'other-branch',
    hasHadSessions: true,
    prs: [
      {
        id: 'pr-1',
        url: 'https://github.com/o/r/pull/1',
        number: 1,
        title: 'First PR',
        headRefName: 'feature',
        baseRefName: 'main',
        state: 'OPEN',
        reviewState: null,
        ciStatus: 'SUCCESS',
        hasMergeConflict: false,
        syncedAt: null,
      },
    ],
    prSummary: {
      totalCount: 1,
      openCount: 1,
      hasNonterminal: true,
      state: 'OPEN',
      ciStatus: 'SUCCESS',
      hasMergeConflict: false,
      ratchetState: 'IDLE',
    },
    prUrl: 'https://github.com/o/r/pull/1',
    prNumber: 1,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: '2026-02-01T00:00:00.000Z',
    hasMergeConflict: true,
    isWorking: true,
    pendingRequestType: 'user_question',
    sessionSummaries: [
      {
        sessionId: 'session-1',
        name: 'Chat 1',
        workflow: 'followup',
        model: 'model',
        provider: 'CLAUDE',
        persistedStatus: 'IDLE',
        runtimePhase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastExit: null,
        errorMessage: null,
      },
    ],
    ratchetEnabled: true,
    ratchetState: 'CI_RUNNING',
    prMonitoring: {
      enabled: true,
      deliveryMode: 'MAIN',
      recipientSessionId: 'session-1',
      bindingRevision: 1,
      pauseReason: 'paused',
      pendingEventCount: 1,
    },
    runScriptStatus: 'RUNNING',
    gitStats: { total: 1, additions: 2, deletions: 3, hasUncommitted: true },
    lastActivityAt: '2026-02-01T00:00:00.000Z',
    worktreePath: '/worktree',
    initErrorMessage: 'Setup failed',
    githubIssueNumber: 1,
    githubIssueUrl: 'https://github.com/o/r/issues/1',
    linearIssueId: 'issue-1',
    linearIssueIdentifier: 'ENG-1',
    linearIssueUrl: 'https://linear.app/team/issue/ENG-1',
    creationSource: 'GITHUB_ISSUE',
  };
}

// Object.keys loses key types; this test-only narrowing is safe for the closed,
// exhaustively checked literal above, without exposing production internals.
export const snapshotInputFields = Object.keys(
  snapshotFieldPolicy
) as (keyof SnapshotUpdateInput)[];
