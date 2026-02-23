import { describe, expect, it } from 'vitest';
import {
  mapSnapshotEntryToServerWorkspace,
  type WorkspaceSnapshotEntry,
} from './snapshot-to-sidebar';

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

describe('mapSnapshotEntryToServerWorkspace', () => {
  it('maps workspaceId to id', () => {
    const entry = makeEntry({ workspaceId: 'ws-abc' });
    const result = mapSnapshotEntryToServerWorkspace(entry);
    expect(result.id).toBe('ws-abc');
  });

  it('maps kanbanColumn to cachedKanbanColumn', () => {
    const entry = makeEntry({ kanbanColumn: 'DONE' });
    const result = mapSnapshotEntryToServerWorkspace(entry);
    expect(result.cachedKanbanColumn).toBe('DONE');
  });

  it('maps computedAt to stateComputedAt', () => {
    const entry = makeEntry({ computedAt: '2026-02-01T12:00:00Z' });
    const result = mapSnapshotEntryToServerWorkspace(entry);
    expect(result.stateComputedAt).toBe('2026-02-01T12:00:00Z');
  });

  it('passes through common fields unchanged', () => {
    const entry = makeEntry();
    const result = mapSnapshotEntryToServerWorkspace(entry);

    expect(result.name).toBe('my-workspace');
    expect(result.createdAt).toEqual(new Date('2026-01-10T08:00:00Z'));
    expect(result.branchName).toBe('feat/snapshot');
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result.prNumber).toBe(42);
    expect(result.prState).toBe('OPEN');
    expect(result.prCiStatus).toBe('SUCCESS');
    expect(result.isWorking).toBe(true);
    expect(result.gitStats).toEqual({
      total: 10,
      additions: 7,
      deletions: 3,
      hasUncommitted: false,
    });
    expect(result.lastActivityAt).toBe('2026-01-15T09:55:00Z');
    expect(result.ratchetEnabled).toBe(true);
    expect(result.ratchetState).toBe('IDLE');
    expect(result.sidebarStatus).toEqual({ activityState: 'WORKING', ciState: 'PASSING' });
    expect(result.ratchetButtonAnimated).toBe(false);
    expect(result.flowPhase).toBe('CI_WAIT');
    expect(result.ciObservation).toBe('CHECKS_PASSED');
    expect(result.runScriptStatus).toBe('IDLE');
    expect(result.pendingRequestType).toBe('plan_approval');
  });

  it('passes through generic permission_request pending state', () => {
    const entry = makeEntry({ pendingRequestType: 'permission_request' });
    const result = mapSnapshotEntryToServerWorkspace(entry);
    expect(result.pendingRequestType).toBe('permission_request');
  });

  it('passes through sessionSummaries', () => {
    const entry = makeEntry({
      sessionSummaries: [
        {
          sessionId: 's-1',
          name: 'Chat 1',
          workflow: 'followup',
          model: 'claude-sonnet',
          persistedStatus: 'IDLE',
          runtimePhase: 'idle',
          processState: 'alive',
          activity: 'IDLE',
          updatedAt: '2026-01-15T09:55:00Z',
          lastExit: null,
        },
      ],
    });
    const result = mapSnapshotEntryToServerWorkspace(entry);

    expect(result.sessionSummaries).toEqual(entry.sessionSummaries);
  });

  it('does not include store-internal fields', () => {
    const entry = makeEntry();
    const result = mapSnapshotEntryToServerWorkspace(entry);

    // These fields exist on the entry but should NOT appear on the result
    const resultObj = result as unknown as Record<string, unknown>;
    expect(resultObj.version).toBeUndefined();
    expect(resultObj.projectId).toBeUndefined();
    expect(resultObj.status).toBeUndefined();
    expect(resultObj.prUpdatedAt).toBeUndefined();
    expect(resultObj.hasHadSessions).toBeUndefined();
    expect(resultObj.source).toBeUndefined();
    expect(resultObj.fieldTimestamps).toBeUndefined();
  });

  it('handles null kanbanColumn', () => {
    const entry = makeEntry({ kanbanColumn: null });
    const result = mapSnapshotEntryToServerWorkspace(entry);
    expect(result.cachedKanbanColumn).toBeNull();
  });

  it('handles null gitStats', () => {
    const entry = makeEntry({ gitStats: null });
    const result = mapSnapshotEntryToServerWorkspace(entry);
    expect(result.gitStats).toBeNull();
  });
});
