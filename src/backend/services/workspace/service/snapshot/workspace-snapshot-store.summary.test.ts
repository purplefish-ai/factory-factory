import { afterEach, describe, expect, it } from 'vitest';
import {
  SNAPSHOT_CHANGED,
  type SnapshotUpdateInput,
  WorkspaceSnapshotStore,
} from '@/backend/services/workspace/service/snapshot/workspace-snapshot-store.service';
import { deriveWorkspaceSidebarStatus } from '@/shared/core';
import { deriveWorkspaceFlowState } from '@/shared/workspace-flow-state';
import {
  WorkspaceSnapshotEntrySchema,
  SnapshotServerMessageSchema,
} from '@/shared/workspace-snapshot';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';

function seed(): SnapshotUpdateInput {
  return {
    projectId: 'project-1',
    name: 'Issue workspace',
    status: 'READY',
    createdAt: '2026-01-01T00:00:00.000Z',
    branchName: 'feature/issue',
    hasHadSessions: false,
    mode: 'STANDARD',
    autoIterationStatus: null,
    autoIteration: null,
    worktreePath: '/work/issue',
    initErrorMessage: null,
    githubIssueNumber: 42,
    githubIssueUrl: 'https://github.com/org/repo/issues/42',
    linearIssueId: null,
    linearIssueIdentifier: null,
    linearIssueUrl: null,
    creationSource: 'GITHUB_ISSUE',
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
    isWorking: false,
    pendingRequestType: null,
    sessionSummaries: [],
    lastActivityAt: null,
  };
}

const stores: WorkspaceSnapshotStore[] = [];
function store() {
  const result = new WorkspaceSnapshotStore();
  result.configure({
    deriveFlowState: (input) =>
      deriveWorkspaceFlowState({
        ...input,
        prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
      }),
    deriveSidebarStatus: deriveWorkspaceSidebarStatus,
  });
  stores.push(result);
  return result;
}
afterEach(() => {
  for (const value of stores.splice(0)) {
    value.clear();
  }
});

function completeEntry() {
  const fields = seed();
  return {
    ...makeWorkspaceSnapshotEntry(),
    ...fields,
    summaryVersion: 1,
    fieldTimestamps: {
      workspace: 1,
      pr: 1,
      session: 1,
      ratchet: 1,
      runScript: 1,
      reconciliation: 1,
      metadata: 1,
      autoIteration: 1,
    },
  };
}

describe('accepted summary hydration', () => {
  it('hydrates older metadata without replacing a newer lifecycle or claiming rejected seed inputs', () => {
    const value = store();
    value.upsert('ws', { projectId: 'project-1', status: 'PROVISIONING' }, 'lifecycle', 500);
    value.upsert('ws', seed(), 'older reconciliation', 100);
    expect(value.getByWorkspaceId('ws')).toMatchObject({
      status: 'PROVISIONING',
      githubIssueNumber: 42,
      worktreePath: '/work/issue',
      creationSource: 'GITHUB_ISSUE',
      fieldTimestamps: { workspace: 500, metadata: 100 },
    });
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    value.upsert('ws', seed(), 'current reconciliation', 600);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBe(1);
    expect(WorkspaceSnapshotEntrySchema.safeParse(value.getByWorkspaceId('ws')).success).toBe(true);
  });

  it('preserves a newer name-only update while older unknown metadata hydrates', () => {
    const value = store();
    value.upsert('ws', { projectId: 'project-1', name: 'Renamed by RPC' }, 'rename', 500);
    value.upsert('ws', seed(), 'older seed', 100);
    expect(value.getByWorkspaceId('ws')).toMatchObject({
      name: 'Renamed by RPC',
      githubIssueNumber: 42,
      creationSource: 'GITHUB_ISSUE',
      worktreePath: '/work/issue',
    });
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
  });

  it('does not count rejected mode or session history even when stored defaults have valid shapes', () => {
    const value = store();
    value.upsert(
      'ws',
      {
        projectId: 'project-1',
        name: 'Issue workspace',
        status: 'READY',
        createdAt: '2026-01-01T00:00:00.000Z',
        branchName: 'feature/issue',
        autoIterationStatus: null,
      },
      'lifecycle',
      500
    );
    value.upsert('ws', seed(), 'older seed', 100);
    expect(value.getByWorkspaceId('ws')).toMatchObject({ mode: 'STANDARD', hasHadSessions: false });
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    value.upsert('ws', { mode: 'STANDARD' }, 'mode accepted', 600);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    value.upsert('ws', { hasHadSessions: false }, 'history accepted', 700);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBe(1);
  });

  it('publishes completeness when an accepted value equals its unhydrated default', () => {
    const value = store();
    const { sessionSummaries: _omitted, ...partial } = seed();
    value.upsert('ws', partial, 'partial seed', 100);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    let emitted = 0;
    value.on(SNAPSHOT_CHANGED, () => {
      emitted++;
    });
    const result = value.upsert('ws', { sessionSummaries: [] }, 'runtime seed', 200);
    expect(result).toEqual({ accepted: true, changed: true, emitted: true });
    expect(emitted).toBe(1);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBe(1);
  });

  it('keeps unknown nullable metadata incomplete until explicit null was accepted', () => {
    const value = store();
    const { linearIssueUrl: _omitted, ...partial } = seed();
    value.upsert('ws', partial, 'partial metadata', 100);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    value.upsert('ws', { linearIssueUrl: null }, 'known absent', 200);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBe(1);
  });

  it('fences metadata independently and accepts explicit clearing', () => {
    const value = store();
    value.upsert('ws', seed(), 'seed', 100);
    value.upsert('ws', { worktreePath: '/new', initErrorMessage: 'warning' }, 'path', 300);
    value.upsert('ws', { status: 'FAILED' }, 'lifecycle', 500);
    value.upsert('ws', { worktreePath: '/stale', initErrorMessage: null }, 'stale', 200);
    expect(value.getByWorkspaceId('ws')).toMatchObject({
      worktreePath: '/new',
      initErrorMessage: 'warning',
    });
    value.upsert('ws', { worktreePath: null, initErrorMessage: null }, 'clear', 400);
    expect(value.getByWorkspaceId('ws')).toMatchObject({
      worktreePath: null,
      initErrorMessage: null,
      status: 'FAILED',
      summaryVersion: 1,
      fieldTimestamps: { metadata: 400, workspace: 500 },
    });
  });

  it('requires new accepted loop hydration after a mode switch and ignores an older different-mode seed', () => {
    const value = store();
    value.upsert('ws', seed(), 'seed', 100);
    value.upsert('ws', { mode: 'AUTO_ITERATION', autoIterationStatus: 'RUNNING' }, 'mode', 800);
    expect(value.getByWorkspaceId('ws')?.autoIteration).toEqual({
      status: 'RUNNING',
      currentIteration: null,
      maxIterations: null,
      currentMetricSummary: null,
    });
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    value.upsert('ws', { mode: 'STANDARD', autoIteration: null }, 'stale loop seed', 700);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
    value.upsert(
      'ws',
      {
        mode: 'AUTO_ITERATION',
        autoIteration: {
          status: 'PAUSED',
          currentIteration: 3,
          maxIterations: 0,
          currentMetricSummary: 'metric=5',
        },
      },
      'loop seed',
      900
    );
    expect(value.getByWorkspaceId('ws')).toMatchObject({
      summaryVersion: 1,
      autoIteration: {
        status: 'RUNNING',
        currentIteration: 3,
        maxIterations: 0,
        currentMetricSummary: 'metric=5',
      },
    });
  });

  it('does not retain hydration after removal and recreation', () => {
    const value = store();
    value.upsert('ws', seed(), 'seed', 100);
    value.remove('ws', 200);
    value.upsert('ws', { projectId: 'project-1', name: 'recreated' }, 'recreate', 300);
    expect(value.getByWorkspaceId('ws')?.summaryVersion).toBeUndefined();
  });
});

describe('summary completeness protocol', () => {
  it('accepts a full flat summary and legacy entries without a version', () => {
    expect(WorkspaceSnapshotEntrySchema.safeParse(completeEntry()).success).toBe(true);
    expect(WorkspaceSnapshotEntrySchema.safeParse(makeWorkspaceSnapshotEntry()).success).toBe(true);
  });
  it.each([
    'worktreePath',
    'initErrorMessage',
    'githubIssueNumber',
    'githubIssueUrl',
    'linearIssueId',
    'linearIssueIdentifier',
    'linearIssueUrl',
    'creationSource',
    'autoIteration',
    'prs',
    'prSummary',
    'prMonitoring',
  ])('rejects a complete claim missing %s even when legacy defaults exist', (field) => {
    const entry = completeEntry();
    Reflect.deleteProperty(entry, field);
    expect(WorkspaceSnapshotEntrySchema.safeParse(entry).success).toBe(false);
  });
  it('does not fill a missing monitoring delivery mode from a legacy default', () => {
    const entry = completeEntry();
    Reflect.deleteProperty(entry.prMonitoring!, 'deliveryMode');
    expect(WorkspaceSnapshotEntrySchema.safeParse(entry).success).toBe(false);
  });
  it('accepts empty baselines and mixed legacy/complete rows, rejecting malformed claims', () => {
    expect(
      SnapshotServerMessageSchema.safeParse({
        type: 'snapshot_full',
        projectId: 'project-1',
        entries: [],
      }).success
    ).toBe(true);
    const entries = [makeWorkspaceSnapshotEntry(), completeEntry()];
    expect(
      SnapshotServerMessageSchema.safeParse({
        type: 'snapshot_full',
        projectId: 'project-1',
        entries,
      }).success
    ).toBe(true);
    expect(
      SnapshotServerMessageSchema.safeParse({
        type: 'snapshot_full',
        projectId: 'project-1',
        entries: [entries[0], { ...entries[1], summaryVersion: 2 }],
      }).success
    ).toBe(false);
  });
  it('rejects a compact loop inconsistent with the accepted mode/status', () => {
    expect(
      WorkspaceSnapshotEntrySchema.safeParse({
        ...completeEntry(),
        mode: 'AUTO_ITERATION',
        autoIteration: null,
      }).success
    ).toBe(false);
    expect(
      WorkspaceSnapshotEntrySchema.safeParse({
        ...completeEntry(),
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        autoIteration: {
          status: 'PAUSED',
          currentIteration: null,
          maxIterations: null,
          currentMetricSummary: null,
        },
      }).success
    ).toBe(false);
  });
});
