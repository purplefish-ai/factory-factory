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

import { KanbanColumn } from '@prisma-gen/client';
import {
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
});
