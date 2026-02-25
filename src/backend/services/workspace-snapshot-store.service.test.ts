import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger (standard pattern)
vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { KanbanColumn } from '@/shared/core';
import {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  type SnapshotUpdateInput,
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
    runScriptStatus: 'IDLE',
    hasHadSessions: false,
    isWorking: false,
    pendingRequestType: null,
    gitStats: null,
    lastActivityAt: null,
    ...overrides,
  };
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

    it('version increments on each upsert', () => {
      for (let i = 0; i < 5; i++) {
        store.upsert('ws-1', makeUpdate(), 'test', 100 + i);
      }

      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.version).toBe(5);
    });

    it('each workspace has independent version counter', () => {
      store.upsert('ws-A', makeUpdate(), 'test', 100);
      store.upsert('ws-A', makeUpdate(), 'test', 200);
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

    it('updates computedAt and source on each upsert', () => {
      store.upsert('ws-1', makeUpdate(), 'source-1', 100);
      const firstComputedAt = store.getByWorkspaceId('ws-1')!.computedAt;

      store.upsert('ws-1', makeUpdate(), 'source-2', 200);
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
  // STORE-06: Field-level timestamps for concurrent update safety
  // -------------------------------------------------------------------------
  describe('STORE-06: Field-level timestamps for concurrent update safety', () => {
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
          if (input.isWorking) {
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

    it('kanbanColumn reflects isWorking from flow state', () => {
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
      // Flow state returns isWorking=true (prUrl set + PENDING)
      // Effective isWorking = session(false) OR flow(true) = true
      expect(entry!.isWorking).toBe(true);
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

      // Initial effective isWorking is true because flow is active.
      expect(store.getByWorkspaceId('ws-1')!.isWorking).toBe(true);

      store.upsert('ws-1', { prCiStatus: 'SUCCESS' }, 'test', 200);

      // Session signal remains false, so effective isWorking should clear.
      const entry = store.getByWorkspaceId('ws-1');
      expect(entry!.isWorking).toBe(false);
      expect(entry!.sidebarStatus.activityState).toBe('IDLE');
      expect(entry!.kanbanColumn).toBe('WAITING');
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

    it('derived state uses effective isWorking (session OR flow)', () => {
      // isWorking=true from session, prUrl=null so flow isWorking=false
      // Effective isWorking should be true (session OR flow)
      store.upsert('ws-1', makeUpdate({ isWorking: true, prUrl: null }), 'test', 100);

      const entry = store.getByWorkspaceId('ws-1');
      // sidebarStatus should reflect effective isWorking=true
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

    it('emits one event per upsert call', () => {
      const handler = vi.fn();
      store.on(SNAPSHOT_CHANGED, handler);

      store.upsert('ws-1', makeUpdate(), 'test', 100);
      store.upsert('ws-1', makeUpdate(), 'test', 200);
      store.upsert('ws-1', makeUpdate(), 'test', 300);

      expect(handler).toHaveBeenCalledTimes(3);
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
  // ARCH-02: No domain imports
  // -------------------------------------------------------------------------
  describe('ARCH-02: No domain imports', () => {
    it('service file has zero imports from @/backend/domains/', () => {
      const serviceFilePath = path.resolve(
        import.meta.dirname,
        'workspace-snapshot-store.service.ts'
      );
      const content = fs.readFileSync(serviceFilePath, 'utf-8');

      // Check only actual import lines, not comments
      const importLines = content.split('\n').filter((line) => /^\s*import\s/.test(line));

      for (const line of importLines) {
        expect(line).not.toContain('@/backend/domains/');
      }
    });
  });
});
