import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import {
  mergeProjectSnapshotIntoWorkspaceDetail,
  projectSnapshotToKanbanWorkspace,
  projectSnapshotToSidebarWorkspace,
  type WorkspaceDetail,
} from './snapshot-to-workspace';

function makeEntry(overrides: Partial<WorkspaceSnapshotEntry> = {}): WorkspaceSnapshotEntry {
  return makeWorkspaceSnapshotEntry({
    version: 3,
    source: 'event:workspace_state_change',
    name: 'my-workspace',
    branchName: 'feat/snapshot',
    prUrl: 'https://github.com/org/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    prUpdatedAt: '2026-01-14T12:00:00Z',
    ratchetEnabled: true,
    ratchetState: 'IDLE',
    runScriptStatus: 'IDLE',
    hasHadSessions: true,
    isWorking: true,
    pendingRequestType: 'plan_approval',
    sessionSummaries: [],
    gitStats: { total: 10, additions: 7, deletions: 3, hasUncommitted: false },
    lastActivityAt: '2026-01-15T09:55:00Z',
    sidebarStatus: { activityState: 'WORKING', ciState: 'PASSING' },
    kanbanColumn: 'WORKING',
    flowPhase: 'CI_WAIT',
    ciObservation: 'CHECKS_PASSED',
    statusReason: {
      code: 'NEEDS_PLAN_APPROVAL',
      label: 'Needs plan approval',
      tone: 'attention',
      needsUser: true,
    },
    fieldTimestamps: {
      workspace: 1000,
      pr: 2000,
      session: 3000,
      ratchet: 4000,
      runScript: 5000,
      reconciliation: 6000,
    },
    ...overrides,
  });
}

describe('workspace snapshot cache projections', () => {
  it('projects common real-time fields consistently across all three cache views', () => {
    const entry = makeEntry({
      sessionSummaries: [
        {
          sessionId: 'session-1',
          name: 'Implementation',
          workflow: 'implement',
          model: 'gpt-5',
          provider: 'CODEX',
          persistedStatus: 'RUNNING',
          runtimePhase: 'running',
          processState: 'alive',
          activity: 'WORKING',
          updatedAt: '2026-01-15T09:55:00Z',
          lastExit: null,
        },
      ],
    });
    const kanban = projectSnapshotToKanbanWorkspace(entry);
    const detailSeed: WorkspaceDetail = {
      ...kanban,
      sessionSummaries: entry.sessionSummaries,
      sidebarStatus: entry.sidebarStatus,
    };
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, detailSeed);
    const projections = [projectSnapshotToSidebarWorkspace(entry), kanban, detail];

    for (const projection of projections) {
      expect(projection).toMatchObject({
        id: 'ws-1',
        name: 'my-workspace',
        createdAt: new Date('2026-01-10T08:00:00Z'),
        branchName: 'feat/snapshot',
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        ratchetEnabled: true,
        ratchetState: 'IDLE',
        runScriptStatus: 'IDLE',
        isWorking: true,
        sessionSummaries: entry.sessionSummaries,
        pendingRequestType: 'plan_approval',
        ratchetButtonAnimated: false,
        flowPhase: 'CI_WAIT',
        ciObservation: 'CHECKS_PASSED',
        statusReason: entry.statusReason,
        snapshotComputedAt: '2026-01-15T10:00:00Z',
      });
    }
  });

  it('maps transport recency separately from preserved DB state timing', () => {
    const entry = makeEntry({ computedAt: '2026-02-01T12:00:00Z' });
    const sidebarSeed = projectSnapshotToSidebarWorkspace(entry);
    const sidebar = projectSnapshotToSidebarWorkspace(entry, {
      ...sidebarSeed,
      stateComputedAt: '2026-01-20T00:00:00Z',
    });
    const kanbanSeed = projectSnapshotToKanbanWorkspace(entry);
    const kanban = projectSnapshotToKanbanWorkspace(entry, {
      ...kanbanSeed,
      stateComputedAt: new Date('2026-01-20T00:00:00Z'),
    });

    expect(sidebar.stateComputedAt).toBe('2026-01-20T00:00:00Z');
    expect(sidebar.snapshotComputedAt).toBe('2026-02-01T12:00:00Z');
    expect(kanban.stateComputedAt).toEqual(new Date('2026-01-20T00:00:00Z'));
  });

  it('applies transported PR update timing to kanban and detail caches', () => {
    const entry = makeEntry({ prUpdatedAt: '2026-02-02T12:00:00Z' });
    const kanban = projectSnapshotToKanbanWorkspace(entry);
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, {
      ...kanban,
      sessionSummaries: entry.sessionSummaries,
      sidebarStatus: entry.sidebarStatus,
    });

    expect(kanban.prUpdatedAt).toEqual(new Date('2026-02-02T12:00:00Z'));
    expect(detail?.prUpdatedAt).toEqual(new Date('2026-02-02T12:00:00Z'));
  });

  it('preserves DB-only issue, creation, and parent fields', () => {
    const entry = makeEntry({ name: 'snapshot-name' });
    const sidebarSeed = projectSnapshotToSidebarWorkspace(entry);
    const sidebar = projectSnapshotToSidebarWorkspace(entry, {
      ...sidebarSeed,
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
    });
    const kanbanSeed = projectSnapshotToKanbanWorkspace(entry);
    const existingKanban = {
      ...kanbanSeed,
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE' as const,
      creationMetadata: { reason: 'delegated' },
      parentWorkspaceId: 'parent-ws',
    };
    const kanban = projectSnapshotToKanbanWorkspace(entry, existingKanban);
    const detailExisting: WorkspaceDetail = {
      ...existingKanban,
      sessionSummaries: entry.sessionSummaries,
      sidebarStatus: entry.sidebarStatus,
    };
    const detail = mergeProjectSnapshotIntoWorkspaceDetail(entry, detailExisting);

    expect(sidebar).toMatchObject({
      name: 'snapshot-name',
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
    });
    expect(kanban).toMatchObject({
      name: 'snapshot-name',
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
      creationMetadata: { reason: 'delegated' },
      parentWorkspaceId: 'parent-ws',
    });
    expect(detail).toMatchObject({
      name: 'snapshot-name',
      githubIssueNumber: 1959,
      githubIssueUrl: 'https://github.com/purplefish-ai/factory-factory/issues/1959',
      linearIssueId: 'linear-id',
      linearIssueIdentifier: 'ENG-1959',
      linearIssueUrl: 'https://linear.app/issue/ENG-1959',
      creationSource: 'CHILD_WORKSPACE',
      creationMetadata: { reason: 'delegated' },
      parentWorkspaceId: 'parent-ws',
    });
  });

  it('preserves archived state from an existing kanban cache entry', () => {
    const entry = makeEntry();
    const existing = {
      ...projectSnapshotToKanbanWorkspace(entry),
      isArchived: true,
    };

    expect(projectSnapshotToKanbanWorkspace(entry, existing).isArchived).toBe(true);
  });

  it('supplies only the router-required defaults for a new kanban entry', () => {
    const result = projectSnapshotToKanbanWorkspace(makeEntry());

    expect(result).toMatchObject({
      projectId: 'proj-1',
      description: null,
      status: 'READY',
      creationSource: 'MANUAL',
      creationMetadata: null,
      initErrorMessage: null,
      updatedAt: new Date('2026-01-10T08:00:00Z'),
      agentSessions: [],
      terminalSessions: [],
      parentWorkspaceId: null,
      stateComputedAt: null,
      isArchived: false,
    });
  });

  it('keeps detail cache absent when no detail was fetched', () => {
    expect(mergeProjectSnapshotIntoWorkspaceDetail(makeEntry(), undefined)).toBeUndefined();
  });
});
