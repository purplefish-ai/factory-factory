import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { serviceNames } from '@/backend/services/registry';
import { computeKanbanColumn, deriveWorkspaceFlowState } from '@/backend/services/workspace';

// Mock logger (standard pattern)
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { deriveWorkspaceSidebarStatus, KanbanColumn } from '@/shared/core';
import { WorkspaceSnapshotEntrySchema } from '@/shared/workspace-snapshot';
import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  type SnapshotUpdateInput,
  type WorkspaceSessionSummary,
  WorkspaceSnapshotStore,
} from './workspace-snapshot-store.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpdate(overrides: Partial<SnapshotUpdateInput> = {}): SnapshotUpdateInput {
  return {
    projectId: 'project-1',
    name: 'Test Workspace',
    status: 'READY',
    createdAt: '2026-01-01T00:00:00Z',
    branchName: 'feature/test',
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    prUpdatedAt: null,
    ratchetEnabled: false,
    ratchetState: 'IDLE',
    ratchetDispatchOutcome: null,
    ratchetDispatchRetryCount: 0,
    runScriptStatus: 'IDLE',
    hasHadSessions: false,
    isWorking: false,
    pendingRequestType: null,
    gitStats: null,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeSessionSummary(
  overrides: Partial<WorkspaceSessionSummary> = {}
): WorkspaceSessionSummary {
  return {
    sessionId: 'session-1',
    name: 'Chat 1',
    workflow: 'followup',
    model: 'claude-sonnet',
    provider: 'CLAUDE',
    persistedStatus: 'IDLE',
    runtimePhase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastExit: {
      code: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      unexpected: false,
    },
    errorMessage: null,
    ...overrides,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkspaceSnapshotStore', () => {
  let store: WorkspaceSnapshotStore;

  beforeEach(() => {
    store = new WorkspaceSnapshotStore();
    store.configure({
      deriveFlowState: (_input) => ({
        phase: 'NO_PR' as const,
        ciObservation: 'CHECKS_UNKNOWN' as const,
        hasActivePr: false,
        isWorking: false,
        shouldAnimateRatchetButton: false,
      }),
      computeKanbanColumn: (_input) => KanbanColumn.WORKING,
      deriveSidebarStatus: (_input) => ({
        activityState: 'IDLE' as const,
        ciState: 'NONE' as const,
      }),
    });
  });

  // -------------------------------------------------------------------------
  // STORE-01: Basic CRUD operations
  // -------------------------------------------------------------------------
  describe('STORE-01: Basic CRUD operations', () => {
    it('creates entry on first upsert', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry).toBeDefined();
      expect(entry!.workspaceId).toBe('ws-1');
      expect(entry!.projectId).toBe('proj-A');
    });

    it('returns undefined for non-existent workspaceId', () => {
      expect(store.getByWorkspaceId('nonexistent')).toBeUndefined();
    });

    it('updates existing entry on subsequent upsert', () => {
      store.upsert('ws-1', makeUpdate({ name: 'Original' }), 'test', 100);
      store.upsert('ws-1', makeUpdate({ name: 'Updated' }), 'test', 200);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.name).toBe('Updated');
    });

    it('getByProjectId returns entries for a project', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-2', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-3', makeUpdate({ projectId: 'proj-B' }), 'test', 100);

      const projA = store.getByProjectId('proj-A');
      const projB = store.getByProjectId('proj-B');

      expect(projA).toHaveLength(2);
      expect(projB).toHaveLength(1);
    });

    it('getByProjectId returns empty array for unknown project', () => {
      expect(store.getByProjectId('nonexistent')).toEqual([]);
    });

    it('size returns correct count', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.upsert('ws-2', makeUpdate(), 'test', 100);
      store.upsert('ws-3', makeUpdate(), 'test', 100);

      expect(store.size()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // STORE-02: Version counter
  // -------------------------------------------------------------------------
  describe('STORE-02: Version counter', () => {
    it('version starts at 1 on first upsert', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.version).toBe(1);
    });

    it('version increments only when snapshot values change', () => {
      store.upsert('ws-1', makeUpdate({ name: 'one' }), 'test', 100);
      store.upsert('ws-1', makeUpdate({ name: 'one' }), 'test', 200);
      store.upsert('ws-1', makeUpdate({ name: 'two' }), 'test', 300);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.version).toBe(2);
    });

    it('each workspace has independent version counter', () => {
      store.upsert('ws-A', makeUpdate(), 'test', 100);
      store.upsert('ws-A', makeUpdate({ name: 'Updated' }), 'test', 200);
      store.upsert('ws-B', makeUpdate(), 'test', 100);

      expect(store.getByWorkspaceId('ws-A')!.version).toBe(2);
      expect(store.getByWorkspaceId('ws-B')!.version).toBe(1);
    });

    it('getVersion returns version for existing entry', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(store.getVersion('ws-1')).toBe(entry!.version);
    });

    it('getVersion returns undefined for non-existent entry', () => {
      expect(store.getVersion('nonexistent')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // STORE-03: Debug metadata
  // -------------------------------------------------------------------------
  describe('STORE-03: Debug metadata', () => {
    it('sets computedAt as ISO timestamp on upsert', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      const parsed = new Date(entry!.computedAt);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('sets source from upsert argument', () => {
      store.upsert('ws-1', makeUpdate(), 'event:pr_state_change', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.source).toBe('event:pr_state_change');
    });

    it('updates computedAt and source on each changed upsert', () => {
      store.upsert('ws-1', makeUpdate(), 'source-1', 100);
      const firstComputedAt = store.getByWorkspaceId('ws-1')!.computedAt;

      store.upsert('ws-1', makeUpdate({ name: 'Updated' }), 'source-2', 200);
      const entry2 = store.getByWorkspaceId('ws-1');

      expect(entry2!.source).toBe('source-2');
      // computedAt should be present and potentially different
      expect(entry2!.computedAt).toBeDefined();
      expect(firstComputedAt).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // STORE-04: Cleanup on remove
  // -------------------------------------------------------------------------
  describe('STORE-04: Cleanup on remove', () => {
    it('remove deletes entry', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.remove('ws-1');

      expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
    });

    it('remove cleans up project index', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-2', makeUpdate({ projectId: 'proj-A' }), 'test', 100);

      store.remove('ws-1');
      expect(store.getByProjectId('proj-A')).toHaveLength(1);

      store.remove('ws-2');
      expect(store.getByProjectId('proj-A')).toEqual([]);
    });

    it('remove returns true when entry existed', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);

      expect(store.remove('ws-1')).toBe(true);
    });

    it('remove returns false when entry did not exist', () => {
      expect(store.remove('nonexistent')).toBe(false);
    });

    it('removed entry cannot be queried', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.remove('ws-1');

      expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
      expect(store.getVersion('ws-1')).toBeUndefined();
    });

    it('clear removes all entries', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-2', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-3', makeUpdate({ projectId: 'proj-B' }), 'test', 100);

      store.clear();

      expect(store.size()).toBe(0);
      expect(store.getByProjectId('proj-A')).toEqual([]);
      expect(store.getByProjectId('proj-B')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Removal tombstones: stale reconcile passes must not resurrect entries
  // -------------------------------------------------------------------------
  describe('Removal tombstones', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('expires removal protection after the configured grace period', () => {
      vi.setSystemTime(1000);
      store.remove('ws-1', 900);
      vi.advanceTimersByTime(10 * 60_000);
      expect(store.removalTombstoneCount()).toBe(0);
    });

    it('repeated removal preserves the newest logical timestamp', () => {
      store.remove('ws-1', 200);
      store.remove('ws-1', 150);
      store.upsert('ws-1', makeUpdate(), 'reconciliation', 175);
      expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
    });

    it('ignores upserts whose timestamp predates the removal', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.remove('ws-1', 200);

      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);
      // A reconcile pass that read the DB before the archive committed
      // upserts with its poll-start timestamp, which is older than removal.
      store.upsert('ws-1', makeUpdate(), 'reconciliation', 150);

      expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it('accepts upserts newer than the removal and clears the tombstone', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.remove('ws-1', 200);

      store.upsert('ws-1', makeUpdate({ name: 'Recreated' }), 'test', 300);

      expect(store.getByWorkspaceId('ws-1')?.name).toBe('Recreated');

      // Tombstone is gone: older-than-removal timestamps merge normally again
      // (still subject to regular field-group timestamp rules).
      store.remove('ws-1', 250);
      store.upsert('ws-1', makeUpdate(), 'test', 260);
      expect(store.getByWorkspaceId('ws-1')).toBeDefined();
    });

    it('preserves the tombstone when a newer first upsert is structurally invalid', () => {
      store.remove('ws-1', 200);

      expect(() => store.upsert('ws-1', { name: 'Invalid' }, 'test', 300)).toThrow(
        'projectId is required on first upsert'
      );
      store.upsert('ws-1', makeUpdate(), 'reconciliation', 150);

      expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
    });

    it('cancels tombstone expiry when a valid newer update recreates the workspace', () => {
      const isolatedStore = new WorkspaceSnapshotStore();
      isolatedStore.configure({
        deriveFlowState: (_input) => ({
          phase: 'NO_PR' as const,
          ciObservation: 'CHECKS_UNKNOWN' as const,
          hasActivePr: false,
          isWorking: false,
          shouldAnimateRatchetButton: false,
        }),
        computeKanbanColumn: (_input) => KanbanColumn.WORKING,
        deriveSidebarStatus: (_input) => ({
          activityState: 'IDLE' as const,
          ciState: 'NONE' as const,
        }),
      });
      isolatedStore.remove('ws-1', 200);
      expect(vi.getTimerCount()).toBe(1);

      isolatedStore.upsert('ws-1', makeUpdate(), 'test', 300);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('records a tombstone even when the store has no entry for the workspace', () => {
      // Archive event can arrive before reconciliation ever populated the
      // entry (e.g. right after startup); a stale reconcile pass must still
      // be blocked from inserting it.
      expect(store.remove('ws-1', 200)).toBe(false);

      store.upsert('ws-1', makeUpdate(), 'reconciliation', 150);

      expect(store.getByWorkspaceId('ws-1')).toBeUndefined();
    });

    it('clear drops tombstones', () => {
      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.remove('ws-1', 200);
      store.clear();

      store.upsert('ws-1', makeUpdate(), 'test', 150);

      expect(store.getByWorkspaceId('ws-1')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // STORE-06: Field-level timestamps for concurrent update safety
  // -------------------------------------------------------------------------
  describe('STORE-06: Field-level timestamps for concurrent update safety', () => {
    it('advances ordering metadata without changing the public snapshot for equal scalars', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);
      store.upsert('ws-1', makeUpdate({ name: 'authoritative' }), 'seed', 100);
      const before = store.getByWorkspaceId('ws-1')!;
      const beforeVersion = before.version;
      const beforeComputedAt = before.computedAt;

      const result = store.upsert('ws-1', { name: 'authoritative' }, 'reconciliation', 200);

      const after = store.getByWorkspaceId('ws-1')!;
      expect(result).toEqual({ accepted: true, changed: false, emitted: false });
      expect(after.fieldTimestamps.workspace).toBe(200);
      expect(after.version).toBe(beforeVersion);
      expect(after.computedAt).toBe(beforeComputedAt);
      expect(after.source).toBe('seed');
      expect(handler).toHaveBeenCalledTimes(1);

      const staleResult = store.upsert('ws-1', { name: 'delayed' }, 'event', 150);
      expect(staleResult).toEqual({ accepted: false, changed: false, emitted: false });
      expect(store.getByWorkspaceId('ws-1')!.name).toBe('authoritative');
    });

    it('treats equal structured reconciliation and session fields as no-ops', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);
      const gitStats = { total: 3, additions: 2, deletions: 1, hasUncommitted: true };
      const sessionSummaries = [makeSessionSummary()];
      store.upsert('ws-1', makeUpdate({ gitStats, sessionSummaries }), 'seed', 100);

      const result = store.upsert(
        'ws-1',
        {
          gitStats: { ...gitStats },
          sessionSummaries: [
            makeSessionSummary({ lastExit: { ...sessionSummaries[0]!.lastExit! } }),
          ],
        },
        'reconciliation',
        200
      );

      const entry = store.getByWorkspaceId('ws-1')!;
      expect(result).toEqual({ accepted: true, changed: false, emitted: false });
      expect(entry.version).toBe(1);
      expect(entry.fieldTimestamps.reconciliation).toBe(200);
      expect(entry.fieldTimestamps.session).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('treats reordered session summaries as equal without changing stored order', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);
      const first = makeSessionSummary({ sessionId: 'session-1', name: 'First' });
      const second = makeSessionSummary({ sessionId: 'session-2', name: 'Second' });
      store.upsert('ws-1', makeUpdate({ sessionSummaries: [first, second] }), 'seed', 100);
      handler.mockClear();

      const result = store.upsert(
        'ws-1',
        { sessionSummaries: [{ ...second }, { ...first }] },
        'reconciliation',
        200
      );

      const entry = store.getByWorkspaceId('ws-1')!;
      expect(result).toEqual({ accepted: true, changed: false, emitted: false });
      expect(entry.sessionSummaries).toEqual([first, second]);
      expect(entry.fieldTimestamps.session).toBe(200);
      expect(entry.version).toBe(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits exactly once when a structured field changes', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);
      store.upsert('ws-1', makeUpdate({ sessionSummaries: [makeSessionSummary()] }), 'seed', 100);
      handler.mockClear();

      const result = store.upsert(
        'ws-1',
        {
          sessionSummaries: [
            makeSessionSummary({
              lastExit: {
                code: 1,
                timestamp: '2026-01-01T00:00:00.000Z',
                unexpected: true,
              },
            }),
          ],
        },
        'event:session_state_change',
        200
      );

      expect(result).toEqual({ accepted: true, changed: true, emitted: true });
      expect(store.getByWorkspaceId('ws-1')!.version).toBe(2);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not ignore additional session summary fields during stable equality', () => {
      store.upsert('ws-1', makeUpdate({ sessionSummaries: [makeSessionSummary()] }), 'seed', 100);
      const expandedSummary = Object.assign(makeSessionSummary(), {
        futureRuntimeDetail: 'new-value',
      });

      const result = store.upsert(
        'ws-1',
        { sessionSummaries: [expandedSummary] },
        'event:session_state_change',
        200
      );

      expect(result).toEqual({ accepted: true, changed: true, emitted: true });
      expect(store.getByWorkspaceId('ws-1')!.sessionSummaries).toEqual([expandedSummary]);
    });

    it('newer timestamp overwrites fields', () => {
      store.upsert('ws-1', makeUpdate({ name: 'old' }), 'test', 100);
      store.upsert('ws-1', { name: 'new' }, 'test', 200);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.name).toBe('new');
    });

    it('older timestamp does not overwrite newer fields', () => {
      store.upsert('ws-1', makeUpdate({ name: 'new' }), 'test', 200);
      store.upsert('ws-1', { name: 'old' }, 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.name).toBe('new');
    });

    it('different field groups can update independently', () => {
      // First upsert sets only workspace-group fields at timestamp 100
      store.upsert(
        'ws-1',
        { projectId: 'project-1', name: 'workspace-name', status: 'READY' as const },
        'test',
        100
      );

      // Second upsert sets only PR-group fields at timestamp 50
      // PR group timestamp was 0 (default), so 50 > 0 applies
      store.upsert('ws-1', { prUrl: 'https://github.com/test/pr/1', prState: 'OPEN' }, 'test', 50);

      const entry = store.getByWorkspaceId('ws-1');
      // Workspace fields still at timestamp 100 values
      expect(entry!.name).toBe('workspace-name');
      // PR fields at timestamp 50 values (50 > 0 default)
      expect(entry!.prUrl).toBe('https://github.com/test/pr/1');
      expect(entry!.prState).toBe('OPEN');
    });

    it('same-timestamp updates are not accepted (strictly newer required)', () => {
      store.upsert('ws-1', makeUpdate({ name: 'original' }), 'test', 100);
      store.upsert('ws-1', { name: 'attempted-overwrite' }, 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      // Same timestamp is not newer, so original values preserved
      expect(entry!.name).toBe('original');
    });

    it('stale projectId updates do not overwrite newer project index state', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-1', { projectId: 'proj-B' }, 'test', 200);

      const versionAfterFreshUpdate = store.getByWorkspaceId('ws-1')!.version;

      // Older workspace-group update must be ignored entirely.
      store.upsert('ws-1', { projectId: 'proj-A' }, 'test', 150);

      const entry = store.getByWorkspaceId('ws-1');
      const inProjectA = store
        .getByProjectId('proj-A')
        .find((workspace) => workspace.workspaceId === 'ws-1');
      const inProjectB = store
        .getByProjectId('proj-B')
        .find((workspace) => workspace.workspaceId === 'ws-1');

      expect(entry!.projectId).toBe('proj-B');
      expect(entry!.version).toBe(versionAfterFreshUpdate);
      expect(inProjectA).toBeUndefined();
      expect(inProjectB).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Project index management
  // -------------------------------------------------------------------------
  describe('Project index management', () => {
    it('handles project index when projectId changes', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-B' }), 'test', 200);

      const projA = store.getByProjectId('proj-A');
      const projB = store.getByProjectId('proj-B');

      expect(projA.find((e) => e.workspaceId === 'ws-1')).toBeUndefined();
      expect(projB.find((e) => e.workspaceId === 'ws-1')).toBeDefined();
    });

    it('project index is cleaned up when last entry removed', () => {
      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.remove('ws-1');

      expect(store.getByProjectId('proj-A')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // STORE-05 + STORE-06: Derived state recomputation
  // -------------------------------------------------------------------------
  describe('STORE-05 + STORE-06: Derived state recomputation', () => {
    // Use smarter mock derivation functions that respond to input values
    beforeEach(() => {
      store.configure({
        deriveFlowState: (input) => ({
          phase: input.prUrl ? ('CI_WAIT' as const) : ('NO_PR' as const),
          ciObservation:
            input.prCiStatus === 'SUCCESS'
              ? ('CHECKS_PASSED' as const)
              : ('CHECKS_UNKNOWN' as const),
          hasActivePr: input.prUrl !== null,
          isWorking: input.prUrl !== null && input.prCiStatus === 'PENDING',
          shouldAnimateRatchetButton: input.ratchetEnabled && input.prCiStatus === 'PENDING',
        }),
        computeKanbanColumn: (input) => {
          if (input.sessionIsWorking || input.flowIsWorking) {
            return KanbanColumn.WORKING;
          }
          if (input.prState === 'MERGED') {
            return KanbanColumn.DONE;
          }
          return KanbanColumn.WAITING;
        },
        deriveSidebarStatus: (input) => ({
          activityState: input.isWorking ? ('WORKING' as const) : ('IDLE' as const),
          ciState: input.prUrl ? ('RUNNING' as const) : ('NONE' as const),
        }),
      });
    });

    it('derived state is computed on first upsert', () => {
      store.upsert('ws-1', makeUpdate({ prUrl: null }), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.flowPhase).toBe('NO_PR');
      expect(entry!.kanbanColumn).toBe('WAITING');
      expect(entry!.sidebarStatus.ciState).toBe('NONE');
    });

    it('derived state recomputes when raw fields change', () => {
      store.upsert('ws-1', makeUpdate({ prUrl: null }), 'test', 100);
      expect(store.getByWorkspaceId('ws-1')!.flowPhase).toBe('NO_PR');

      store.upsert(
        'ws-1',
        { prUrl: 'https://github.com/org/repo/pull/1', prCiStatus: 'PENDING' },
        'test',
        200
      );

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.flowPhase).toBe('CI_WAIT');
      expect(entry!.sidebarStatus.ciState).toBe('RUNNING');
    });

    it('keeps PR flow automation-owned without treating it as live agent work', () => {
      store.upsert(
        'ws-1',
        makeUpdate({
          prUrl: 'https://github.com/org/repo/pull/1',
          prCiStatus: 'PENDING',
        }),
        'test',
        100
      );

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.flowPhase).toBe('CI_WAIT');
      expect(entry!.isWorking).toBe(false);
      expect(entry!.sidebarStatus.activityState).toBe('IDLE');
      expect(entry!.kanbanColumn).toBe('WORKING');
    });

    it('does not latch flow-derived isWorking across PR-only updates', () => {
      store.upsert(
        'ws-1',
        makeUpdate({
          isWorking: false,
          prUrl: 'https://github.com/org/repo/pull/1',
          prCiStatus: 'PENDING',
        }),
        'test',
        100
      );

      // PR flow can be active without making the workspace look like an agent is working.
      expect(store.getByWorkspaceId('ws-1')!.isWorking).toBe(false);

      store.upsert('ws-1', { prCiStatus: 'SUCCESS' }, 'test', 200);

      // Session signal remains false, so visible isWorking should stay clear.
      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.isWorking).toBe(false);
      expect(entry!.sidebarStatus.activityState).toBe('IDLE');
      expect(entry!.kanbanColumn).toBe('WAITING');
    });

    it('moves exhausted Ratchet dispatches to waiting without reporting live agent work', () => {
      store.configure({
        deriveFlowState: (input) =>
          deriveWorkspaceFlowState({
            ...input,
            prUpdatedAt: input.prUpdatedAt ? new Date(input.prUpdatedAt) : null,
          }),
        computeKanbanColumn,
        deriveSidebarStatus: deriveWorkspaceSidebarStatus,
      });
      store.upsert(
        'ws-1',
        makeUpdate({
          prUrl: 'https://github.com/org/repo/pull/1',
          prState: 'OPEN',
          ratchetEnabled: true,
          isWorking: false,
        }),
        'test',
        100
      );

      const transitions: SnapshotUpdateInput[] = [
        { prCiStatus: 'PENDING', ratchetState: 'CI_RUNNING' },
        { prCiStatus: 'FAILURE', ratchetState: 'CI_RUNNING' },
        { ratchetState: 'CI_FAILED', ratchetDispatchOutcome: 'RUNNING' },
        {
          ratchetState: 'CI_FAILED',
          ratchetDispatchOutcome: 'DIED',
          ratchetDispatchRetryCount: SERVICE_THRESHOLDS.ratchetDispatchMaxRetries,
        },
      ];
      const columns: Array<string | null> = [];

      for (const [index, update] of transitions.entries()) {
        store.upsert('ws-1', update, 'test', 200 + index);
        const entry = store.getByWorkspaceId('ws-1');
        expect(entry?.isWorking).toBe(false);
        columns.push(entry?.kanbanColumn ?? null);
      }

      expect(columns).toEqual(['WORKING', 'WORKING', 'WORKING', 'WAITING']);
    });

    it('ratchetButtonAnimated reflects flow state', () => {
      store.upsert(
        'ws-1',
        makeUpdate({
          ratchetEnabled: true,
          prUrl: 'https://github.com/org/repo/pull/1',
          prCiStatus: 'PENDING',
        }),
        'test',
        100
      );

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.ratchetButtonAnimated).toBe(true);
    });

    it('derived state uses session activity for visible working state', () => {
      // isWorking=true from session, prUrl=null so flow isWorking=false
      store.upsert('ws-1', makeUpdate({ isWorking: true, prUrl: null }), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.sidebarStatus.activityState).toBe('WORKING');
    });

    it('authoritative isWorking=false is not overridden by stale session summaries', () => {
      store.upsert(
        'ws-1',
        makeUpdate({
          isWorking: true,
          sessionSummaries: [
            {
              sessionId: 's-1',
              name: 'Chat 1',
              workflow: 'followup',
              model: 'claude-sonnet',
              persistedStatus: 'RUNNING',
              runtimePhase: 'running',
              processState: 'alive',
              activity: 'WORKING',
              updatedAt: '2026-01-01T00:00:00Z',
              lastExit: null,
            },
          ],
        }),
        'test',
        100
      );

      // Simulate workspace_idle arriving before refreshed session summaries.
      store.upsert('ws-1', { isWorking: false }, 'test', 200);

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.isWorking).toBe(false);
      expect(entry!.sidebarStatus.activityState).toBe('IDLE');
      expect(entry!.kanbanColumn).toBe('WAITING');
    });

    it('emits when only the time-sensitive derived candidate changes', () => {
      let flowPhase: 'NO_PR' | 'CI_WAIT' = 'NO_PR';
      store.configure({
        deriveFlowState: () => ({
          phase: flowPhase,
          ciObservation: 'CHECKS_UNKNOWN',
          hasActivePr: flowPhase !== 'NO_PR',
          isWorking: false,
          shouldAnimateRatchetButton: false,
        }),
        computeKanbanColumn: () => KanbanColumn.WAITING,
        deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'NONE' }),
      });
      store.upsert('ws-1', makeUpdate(), 'seed', 100);
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);
      flowPhase = 'CI_WAIT';

      const result = store.upsert('ws-1', makeUpdate(), 'reconciliation', 200);

      expect(result).toEqual({ accepted: true, changed: true, emitted: true });
      expect(store.getByWorkspaceId('ws-1')!.flowPhase).toBe('CI_WAIT');
      expect(store.getByWorkspaceId('ws-1')!.version).toBe(2);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------
  describe('Event emission', () => {
    it('emits snapshot_changed on upsert', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);

      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);

      expect(handler).toHaveBeenCalledTimes(1);
      const event: SnapshotChangedEvent = handler.mock.calls[0]![0];
      expect(event.workspaceId).toBe('ws-1');
      expect(event.projectId).toBe('proj-A');
      expect(event.entry).toBeDefined();
      expect(event.entry.workspaceId).toBe('ws-1');
      expect(() => WorkspaceSnapshotEntrySchema.parse(event.entry)).not.toThrow();
    });

    it('emits snapshot_removed on remove', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_REMOVED, handler);

      store.upsert('ws-1', makeUpdate({ projectId: 'proj-A' }), 'test', 100);
      store.remove('ws-1');

      expect(handler).toHaveBeenCalledTimes(1);
      const event: SnapshotRemovedEvent = handler.mock.calls[0]![0];
      expect(event.workspaceId).toBe('ws-1');
      expect(event.projectId).toBe('proj-A');
    });

    it('does not emit snapshot_removed for non-existent entry', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_REMOVED, handler);

      store.remove('nonexistent');

      expect(handler).not.toHaveBeenCalled();
    });

    it('snapshot_changed event has fully consistent entry', () => {
      // Use smart derivation functions for this test
      store.configure({
        deriveFlowState: (input) => ({
          phase: input.prUrl ? ('CI_WAIT' as const) : ('NO_PR' as const),
          ciObservation: 'CHECKS_UNKNOWN' as const,
          hasActivePr: input.prUrl !== null,
          isWorking: false,
          shouldAnimateRatchetButton: false,
        }),
        computeKanbanColumn: (_input) => KanbanColumn.WORKING,
        deriveSidebarStatus: (_input) => ({
          activityState: 'IDLE' as const,
          ciState: 'NONE' as const,
        }),
      });

      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);

      store.upsert(
        'ws-1',
        makeUpdate({ prUrl: 'https://github.com/org/repo/pull/1' }),
        'test',
        100
      );

      const event: SnapshotChangedEvent = handler.mock.calls[0]![0];
      // Derived state should already be computed in the event entry
      expect(event.entry.flowPhase).toBe('CI_WAIT');
    });

    it('emits only for upserts that change snapshot values', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);

      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.upsert('ws-1', makeUpdate(), 'test', 200);
      store.upsert('ws-1', makeUpdate({ name: 'Updated' }), 'test', 300);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not emit or bump version when stale update is fully ignored', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);

      store.upsert('ws-1', makeUpdate({ name: 'fresh' }), 'test', 200);
      const entryBeforeStaleUpdate = store.getByWorkspaceId('ws-1');

      store.upsert('ws-1', { name: 'stale' }, 'test', 100);

      const entryAfterStaleUpdate = store.getByWorkspaceId('ws-1');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(entryAfterStaleUpdate!.name).toBe('fresh');
      expect(entryAfterStaleUpdate!.version).toBe(entryBeforeStaleUpdate!.version);
      expect(entryAfterStaleUpdate!.source).toBe(entryBeforeStaleUpdate!.source);
      expect(entryAfterStaleUpdate!.computedAt).toBe(entryBeforeStaleUpdate!.computedAt);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('Error handling', () => {
    it('throws on upsert without configure()', () => {
      const unconfiguredStore = new WorkspaceSnapshotStore();

      expect(() => {
        unconfiguredStore.upsert('ws-1', makeUpdate(), 'test', 100);
      }).toThrow('not configured');
    });

    it('throws on first upsert without projectId', () => {
      const { projectId: _, ...updateWithoutProjectId } = makeUpdate();

      expect(() => {
        store.upsert('ws-1', updateWithoutProjectId, 'test', 100);
      }).toThrow('projectId');
    });
  });

  // -------------------------------------------------------------------------
  // ARCH-02: No service capsule imports
  // -------------------------------------------------------------------------
  describe('ARCH-02: No service capsule imports', () => {
    it('service file has zero imports from service capsule roots', () => {
      const serviceFilePath = path.resolve(
        import.meta.dirname,
        'workspace-snapshot-store.service.ts'
      );
      const content = fs.readFileSync(serviceFilePath, 'utf-8');
      const serviceCapsulePattern = serviceNames.map(escapeRegExp).join('|');
      const forbiddenServiceCapsuleImport = new RegExp(
        `@/backend/services/(?:${serviceCapsulePattern})(?:/|['"])`
      );

      // Check only actual import lines, not comments
      const importLines = content.split('\n').filter((line) => /^\s*import\s/.test(line));

      for (const line of importLines) {
        expect(line).not.toMatch(forbiddenServiceCapsuleImport);
      }
    });
  });
});
