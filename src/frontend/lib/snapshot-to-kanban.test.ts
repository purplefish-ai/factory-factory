import { describe, expect, it } from 'vitest';
import { mapSnapshotEntryToKanbanWorkspace } from './snapshot-to-kanban';
import type { WorkspaceSnapshotEntry } from './snapshot-to-sidebar';

// =============================================================================
// Test factory
// =============================================================================

function makeEntry(overrides: Partial<WorkspaceSnapshotEntry> = {}): WorkspaceSnapshotEntry {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    version: 3,
    computedAt: '2026-01-15T10:00:00Z',
    source: 'event:workspace_state_change',
    name: 'my-workspace',
    status: 'ACTIVE',
    createdAt: '2026-01-10T08:00:00Z',
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
    ratchetButtonAnimated: false,
    fieldTimestamps: {
      workspace: 1000,
      pr: 2000,
      session: 3000,
      ratchet: 4000,
      runScript: 5000,
      reconciliation: 6000,
    },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('mapSnapshotEntryToKanbanWorkspace', () => {
  it('maps workspaceId to id', () => {
    const entry = makeEntry({ workspaceId: 'ws-abc' });
    const result = mapSnapshotEntryToKanbanWorkspace(entry);
    expect(result.id).toBe('ws-abc');
  });

  it('converts createdAt string to Date', () => {
    const entry = makeEntry({ createdAt: '2026-01-10T08:00:00Z' });
    const result = mapSnapshotEntryToKanbanWorkspace(entry);
    expect(result.createdAt).toEqual(new Date('2026-01-10T08:00:00Z'));
  });

  it('maps all snapshot fields correctly', () => {
    const entry = makeEntry();
    const result = mapSnapshotEntryToKanbanWorkspace(entry);

    expect(result.name).toBe('my-workspace');
    expect(result.status).toBe('ACTIVE');
    expect(result.branchName).toBe('feat/snapshot');
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result.prNumber).toBe(42);
    expect(result.prState).toBe('OPEN');
    expect(result.prCiStatus).toBe('SUCCESS');
    expect(result.ratchetEnabled).toBe(true);
    expect(result.ratchetState).toBe('IDLE');
    expect(result.runScriptStatus).toBe('IDLE');
    expect(result.kanbanColumn).toBe('WORKING');
    expect(result.isWorking).toBe(true);
    expect(result.ratchetButtonAnimated).toBe(false);
    expect(result.flowPhase).toBe('CI_WAIT');
    expect(result.pendingRequestType).toBe('plan_approval');
    expect(result.sessionSummaries).toEqual([]);
  });

  it('maps generic permission_request pending state', () => {
    const entry = makeEntry({ pendingRequestType: 'permission_request' });
    const result = mapSnapshotEntryToKanbanWorkspace(entry);
    expect(result.pendingRequestType).toBe('permission_request');
  });

  it('merges missing-from-snapshot fields from existing cache entry', () => {
    const entry = makeEntry();
    const existing = {
      description: 'A workspace for testing',
      initErrorMessage: 'Some init error',
      githubIssueNumber: 99,
    };
    const result = mapSnapshotEntryToKanbanWorkspace(entry, existing);

    expect(result.description).toBe('A workspace for testing');
    expect(result.initErrorMessage).toBe('Some init error');
    expect(result.githubIssueNumber).toBe(99);
  });

  it('defaults missing-from-snapshot fields to null when no existing entry', () => {
    const entry = makeEntry();
    const result = mapSnapshotEntryToKanbanWorkspace(entry);

    expect(result.description).toBeNull();
    expect(result.initErrorMessage).toBeNull();
    expect(result.githubIssueNumber).toBeNull();
  });

  it('defaults missing-from-snapshot fields to null when existing entry lacks them', () => {
    const entry = makeEntry();
    const existing = { id: 'ws-1', name: 'old' };
    const result = mapSnapshotEntryToKanbanWorkspace(entry, existing);

    expect(result.description).toBeNull();
    expect(result.initErrorMessage).toBeNull();
    expect(result.githubIssueNumber).toBeNull();
  });

  it('always sets isArchived to false', () => {
    const entry = makeEntry();
    const result = mapSnapshotEntryToKanbanWorkspace(entry);
    expect(result.isArchived).toBe(false);
  });

  it('passes through kanbanColumn as-is (non-null)', () => {
    const entry = makeEntry({ kanbanColumn: 'DONE' });
    const result = mapSnapshotEntryToKanbanWorkspace(entry);
    expect(result.kanbanColumn).toBe('DONE');
  });

  it('passes through kanbanColumn as-is (null)', () => {
    const entry = makeEntry({ kanbanColumn: null });
    const result = mapSnapshotEntryToKanbanWorkspace(entry);
    expect(result.kanbanColumn).toBeNull();
  });
});
