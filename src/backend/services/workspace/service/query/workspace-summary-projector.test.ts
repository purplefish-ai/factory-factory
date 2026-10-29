import { describe, expect, it } from 'vitest';
import { projectWorkspaceSummary } from '@/backend/services/workspace/service/query/workspace-summary-projector';

function source() {
  return {
    id: 'workspace',
    projectId: 'project',
    name: 'Loop',
    status: 'READY' as const,
    createdAt: new Date('2026-10-27T12:00:00Z'),
    branchName: 'feature',
    worktreePath: '/worktree',
    initErrorMessage: null,
    mode: 'AUTO_ITERATION' as const,
    autoIterationStatus: 'RUNNING' as const,
    autoIterationConfig: {
      testCommand: 'pnpm test',
      targetDescription: 'coverage',
      maxIterations: 0,
      testTimeoutSeconds: 120,
    },
    autoIterationProgress: {
      currentIteration: 7,
      currentMetricSummary: '85% coverage',
      lastTestOutput: 'large output',
    },
    prs: [],
    prSummary: {
      totalCount: 0,
      openCount: 0,
      hasNonterminal: false,
      state: 'NONE' as const,
      ciStatus: 'UNKNOWN' as const,
      hasMergeConflict: false,
      ratchetState: 'IDLE' as const,
    },
    prUrl: null,
    prNumber: null,
    prState: 'NONE' as const,
    prCiStatus: 'UNKNOWN' as const,
    ratchetEnabled: true,
    ratchetState: 'IDLE' as const,
    prMonitoring: {
      deliveryMode: 'MAIN' as const,
      enabled: true,
      recipientSessionId: 'session',
      bindingRevision: 2,
      pauseReason: null,
      pendingEventCount: 1,
    },
    runScriptStatus: 'RUNNING' as const,
    githubIssueNumber: 4,
    githubIssueUrl: 'https://github.com/org/repo/issues/4',
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    creationSource: 'GITHUB_ISSUE' as const,
    detailOnlySecret: 'do not project',
  };
}
const derivedState = {
  isWorking: true,
  kanbanColumn: 'WORKING' as const,
  sidebarStatus: { activityState: 'WORKING' as const, ciState: 'NONE' as const },
  ratchetButtonAnimated: false,
  flowPhase: 'NO_PR' as const,
  ciObservation: 'NOT_FETCHED' as const,
  statusReason: {
    code: 'AGENT_WORKING' as const,
    label: 'Working',
    tone: 'working' as const,
    needsUser: false,
  },
};

describe('HTTP workspace summary projector', () => {
  it('omits retired loop fields while preserving workspace, PR binding and Date', () => {
    const workspace = source();
    const row = projectWorkspaceSummary(workspace, {
      sessionSummaries: [],
      pendingRequestType: null,
      derivedState,
      gitStats: { total: 8, additions: 6, deletions: 2, hasUncommitted: true },
      lastActivityAt: '2026-10-27T13:00:00Z',
    });
    expect(row).toMatchObject({
      id: 'workspace',
      projectId: 'project',
      status: 'READY',
      branchName: 'feature',
      worktreePath: '/worktree',
      githubIssueNumber: 4,
      githubIssueUrl: 'https://github.com/org/repo/issues/4',
      creationSource: 'GITHUB_ISSUE',
      prMonitoring: { recipientSessionId: 'session', bindingRevision: 2, pendingEventCount: 1 },
      gitStats: { total: 8, additions: 6, deletions: 2, hasUncommitted: true },
      runScriptStatus: 'RUNNING',
      lastActivityAt: '2026-10-27T13:00:00Z',
      statusReason: { code: 'AGENT_WORKING' },
    });
    expect(row.createdAt).toBe(workspace.createdAt);
    for (const key of [
      'mode',
      'autoIteration',
      'autoIterationStatus',
      'autoIterationConfig',
      'autoIterationProgress',
    ]) {
      expect(row).not.toHaveProperty(key);
    }
    expect(row.prs).toBe(workspace.prs);
    expect(row).not.toHaveProperty('detailOnlySecret');
  });
});
