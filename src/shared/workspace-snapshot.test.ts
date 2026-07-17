import { describe, expect, it } from 'vitest';
import {
  SnapshotServerMessageSchema,
  WorkspaceSnapshotEntrySchema,
} from '@/shared/workspace-snapshot';

function makeCompleteSnapshot() {
  return {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    version: 3,
    computedAt: '2026-07-17T12:00:00.000Z',
    source: 'event:workspace_state_change',
    name: 'Snapshot contract',
    status: 'READY',
    createdAt: '2026-07-17T11:00:00.000Z',
    branchName: 'feature/snapshot-contract',
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
    prCiStatus: 'PENDING',
    prUpdatedAt: '2026-07-17T11:30:00.000Z',
    ratchetEnabled: true,
    ratchetState: 'CI_RUNNING',
    runScriptStatus: 'RUNNING',
    hasHadSessions: true,
    isWorking: true,
    pendingRequestType: 'permission_request',
    sessionSummaries: [
      {
        sessionId: 'session-1',
        name: 'Implement contract',
        workflow: 'followup',
        model: 'gpt-5',
        provider: 'CODEX',
        persistedStatus: 'RUNNING',
        runtimePhase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: '2026-07-17T11:45:00.000Z',
        lastExit: {
          code: 0,
          timestamp: '2026-07-17T11:40:00.000Z',
          unexpected: false,
        },
        errorMessage: null,
      },
    ],
    gitStats: {
      total: 12,
      additions: 10,
      deletions: 2,
      hasUncommitted: true,
    },
    lastActivityAt: '2026-07-17T11:50:00.000Z',
    sidebarStatus: {
      activityState: 'WORKING',
      ciState: 'RUNNING',
    },
    kanbanColumn: 'WORKING',
    flowPhase: 'CI_WAIT',
    ciObservation: 'CHECKS_PENDING',
    ratchetButtonAnimated: true,
    statusReason: {
      code: 'NEEDS_PERMISSION',
      label: 'Needs permission',
      tone: 'attention',
      needsUser: true,
    },
    fieldTimestamps: {
      workspace: 1,
      pr: 2,
      session: 3,
      ratchet: 4,
      runScript: 5,
      reconciliation: 6,
    },
  };
}

describe('workspace snapshot transport contract', () => {
  it('parses full, changed, and removed server messages', () => {
    const entry = makeCompleteSnapshot();

    expect(
      SnapshotServerMessageSchema.parse({
        type: 'snapshot_full',
        projectId: 'project-1',
        entries: [entry],
        reviewCount: 2,
      })
    ).toMatchObject({ type: 'snapshot_full', entries: [entry] });
    expect(
      SnapshotServerMessageSchema.parse({
        type: 'snapshot_changed',
        workspaceId: 'workspace-1',
        entry,
        reviewCount: 3,
      })
    ).toMatchObject({ type: 'snapshot_changed', entry });
    expect(
      SnapshotServerMessageSchema.parse({
        type: 'snapshot_removed',
        workspaceId: 'workspace-1',
        reviewCount: 4,
      })
    ).toEqual({
      type: 'snapshot_removed',
      workspaceId: 'workspace-1',
      reviewCount: 4,
    });
  });

  it('rejects an unknown workspace status', () => {
    expect(() =>
      WorkspaceSnapshotEntrySchema.parse({ ...makeCompleteSnapshot(), status: 'ACTIVE' })
    ).toThrow();
  });

  it('rejects a null flow phase', () => {
    expect(() =>
      WorkspaceSnapshotEntrySchema.parse({ ...makeCompleteSnapshot(), flowPhase: null })
    ).toThrow();
  });

  it('rejects field timestamps missing reconciliation', () => {
    const entry = makeCompleteSnapshot();
    const { reconciliation: _reconciliation, ...fieldTimestamps } = entry.fieldTimestamps;

    expect(() => WorkspaceSnapshotEntrySchema.parse({ ...entry, fieldTimestamps })).toThrow();
  });
});
