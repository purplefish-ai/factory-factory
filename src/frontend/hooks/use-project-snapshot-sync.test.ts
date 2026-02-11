import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSnapshotEntry } from '@/frontend/lib/snapshot-to-sidebar';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { useProjectSnapshotSync } from './use-project-snapshot-sync';

// =============================================================================
// Mocks (vi.mock calls are hoisted above imports by vitest)
// =============================================================================

// Mock React hooks to be simple pass-throughs (avoids needing a React rendering context)
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: (...args: never[]) => unknown) => fn,
  };
});

// Capture the options passed to useWebSocketTransport
let capturedOptions: UseWebSocketTransportOptions | null = null;

vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (opts: UseWebSocketTransportOptions) => {
    capturedOptions = opts;
    return { connected: true, send: vi.fn(), reconnect: vi.fn() };
  },
}));

const mockSetData = vi.fn();
const mockKanbanSetData = vi.fn();

vi.mock('@/frontend/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        getProjectSummaryState: {
          setData: mockSetData,
        },
        listWithKanbanState: {
          setData: mockKanbanSetData,
        },
      },
    }),
  },
}));

// =============================================================================
// Test factory
// =============================================================================

function makeEntry(overrides: Partial<WorkspaceSnapshotEntry> = {}): WorkspaceSnapshotEntry {
  return {
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    version: 1,
    computedAt: '2026-01-15T10:00:00Z',
    source: 'event:workspace_state_change',
    name: 'test-workspace',
    status: 'ACTIVE',
    createdAt: '2026-01-10T08:00:00Z',
    branchName: 'feat/test',
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
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    kanbanColumn: 'WORKING',
    flowPhase: 'NO_PR',
    ciObservation: 'NOT_FETCHED',
    ratchetButtonAnimated: false,
    fieldTimestamps: {
      workspace: 1000,
      pr: 0,
      session: 0,
      ratchet: 0,
      runScript: 0,
      reconciliation: 0,
    },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('useProjectSnapshotSync', () => {
  beforeEach(() => {
    capturedOptions = null;
    mockSetData.mockReset();
    mockKanbanSetData.mockReset();
  });

  it('sets URL to null when projectId is undefined', () => {
    useProjectSnapshotSync(undefined);
    expect(capturedOptions?.url).toBeNull();
  });

  it('builds a WebSocket URL when projectId is provided', () => {
    useProjectSnapshotSync('proj-1');
    expect(capturedOptions?.url).toContain('/snapshots');
    expect(capturedOptions?.url).toContain('projectId=proj-1');
  });

  it('uses drop queue policy', () => {
    useProjectSnapshotSync('proj-1');
    expect(capturedOptions?.queuePolicy).toBe('drop');
  });

  // ===========================================================================
  // Sidebar cache tests (getProjectSummaryState)
  // ===========================================================================

  describe('snapshot_full message (sidebar)', () => {
    it('calls setData with mapped entries and preserves reviewCount from prev', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', name: 'alpha' });
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [entry],
      });

      expect(mockSetData).toHaveBeenCalledTimes(1);
      const [inputKey, updater] = mockSetData.mock.calls[0]!;
      expect(inputKey).toEqual({ projectId: 'proj-1' });

      // Invoke the updater with a previous value that has reviewCount
      const result = updater({ workspaces: [], reviewCount: 5 });
      expect(result.workspaces).toHaveLength(1);
      expect(result.workspaces[0].id).toBe('ws-1');
      expect(result.workspaces[0].name).toBe('alpha');
      expect(result.reviewCount).toBe(5);
    });

    it('defaults reviewCount to 0 when no prev exists', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [],
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result.reviewCount).toBe(0);
      expect(result.workspaces).toHaveLength(0);
    });
  });

  describe('snapshot_changed message (sidebar)', () => {
    it('replaces an existing workspace (upsert)', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', name: 'updated-name' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      expect(mockSetData).toHaveBeenCalledTimes(1);
      const [inputKey, updater] = mockSetData.mock.calls[0]!;
      expect(inputKey).toEqual({ projectId: 'proj-1' });

      const prev = {
        workspaces: [
          { id: 'ws-1', name: 'old-name' },
          { id: 'ws-2', name: 'other' },
        ],
        reviewCount: 3,
      };
      const result = updater(prev);
      expect(result.workspaces).toHaveLength(2);
      expect(result.workspaces[0].name).toBe('updated-name');
      expect(result.workspaces[1].name).toBe('other');
      expect(result.reviewCount).toBe(3);
    });

    it('appends a new workspace when not found', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-new', name: 'new-workspace' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-new',
        entry,
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const prev = {
        workspaces: [{ id: 'ws-1', name: 'existing' }],
        reviewCount: 1,
      };
      const result = updater(prev);
      expect(result.workspaces).toHaveLength(2);
      expect(result.workspaces[1].name).toBe('new-workspace');
      expect(result.reviewCount).toBe(1);
    });

    it('handles null prev by creating a single-workspace list', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result.workspaces).toHaveLength(1);
      expect(result.reviewCount).toBe(0);
    });
  });

  describe('snapshot_removed message (sidebar)', () => {
    it('filters out the removed workspace', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      });

      expect(mockSetData).toHaveBeenCalledTimes(1);
      const [inputKey, updater] = mockSetData.mock.calls[0]!;
      expect(inputKey).toEqual({ projectId: 'proj-1' });

      const prev = {
        workspaces: [
          { id: 'ws-1', name: 'gone' },
          { id: 'ws-2', name: 'stays' },
        ],
        reviewCount: 7,
      };
      const result = updater(prev);
      expect(result.workspaces).toHaveLength(1);
      expect(result.workspaces[0].name).toBe('stays');
      expect(result.reviewCount).toBe(7);
    });

    it('returns prev unchanged when prev is null', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result).toBeUndefined();
    });
  });

  // ===========================================================================
  // Kanban cache tests (listWithKanbanState)
  // ===========================================================================

  describe('snapshot_full message (kanban)', () => {
    it('calls kanban setData and filters out entries with null kanbanColumn', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entryWithColumn = makeEntry({ workspaceId: 'ws-1', kanbanColumn: 'WORKING' });
      const entryWithoutColumn = makeEntry({ workspaceId: 'ws-2', kanbanColumn: null });
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [entryWithColumn, entryWithoutColumn],
      });

      expect(mockKanbanSetData).toHaveBeenCalledTimes(1);
      const [inputKey, updater] = mockKanbanSetData.mock.calls[0]!;
      expect(inputKey).toEqual({ projectId: 'proj-1' });

      const result = updater(undefined);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('ws-1');
      expect(result[0].kanbanColumn).toBe('WORKING');
    });

    it('merges existing cache entries for non-snapshot fields', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', kanbanColumn: 'WORKING' });
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [entry],
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const prev = [{ id: 'ws-1', description: 'cached description', githubIssueNumber: 42 }];
      const result = updater(prev);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe('cached description');
      expect(result[0].githubIssueNumber).toBe(42);
    });
  });

  describe('snapshot_changed message (kanban)', () => {
    it('upserts into kanban cache (replaces existing)', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', name: 'updated', kanbanColumn: 'DONE' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      expect(mockKanbanSetData).toHaveBeenCalledTimes(1);
      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const prev = [
        { id: 'ws-1', name: 'old' },
        { id: 'ws-2', name: 'other' },
      ];
      const result = updater(prev);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('updated');
      expect(result[0].kanbanColumn).toBe('DONE');
      expect(result[1].name).toBe('other');
    });

    it('appends new workspace to kanban cache', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-new', kanbanColumn: 'WORKING' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-new',
        entry,
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const prev = [{ id: 'ws-1', name: 'existing' }];
      const result = updater(prev);
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe('ws-new');
    });

    it('removes from kanban cache when kanbanColumn is null', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', kanbanColumn: null });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const prev = [
        { id: 'ws-1', name: 'to-remove' },
        { id: 'ws-2', name: 'stays' },
      ];
      const result = updater(prev);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('stays');
    });

    it('returns prev unchanged when kanbanColumn is null and no prev', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', kanbanColumn: null });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result).toBeUndefined();
    });

    it('merges existing cache entry fields (description, githubIssueNumber)', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', kanbanColumn: 'WORKING' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const prev = [{ id: 'ws-1', description: 'my desc', githubIssueNumber: 7 }];
      const result = updater(prev);
      expect(result[0].description).toBe('my desc');
      expect(result[0].githubIssueNumber).toBe(7);
    });

    it('creates single-item list when prev is null', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', kanbanColumn: 'WORKING' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('ws-1');
    });
  });

  describe('snapshot_removed message (kanban)', () => {
    it('removes from kanban cache', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      });

      expect(mockKanbanSetData).toHaveBeenCalledTimes(1);
      const [inputKey, updater] = mockKanbanSetData.mock.calls[0]!;
      expect(inputKey).toEqual({ projectId: 'proj-1' });

      const prev = [
        { id: 'ws-1', name: 'gone' },
        { id: 'ws-2', name: 'stays' },
      ];
      const result = updater(prev);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('stays');
    });

    it('returns prev unchanged when prev is null', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      });

      const [, updater] = mockKanbanSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result).toBeUndefined();
    });
  });
});
