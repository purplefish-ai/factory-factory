import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetPendingRatchetTogglesForTests,
  setPendingRatchetToggle,
} from '@/client/lib/ratchet-toggle-cache';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import { makeWorkspaceSnapshotEntry as makeEntry } from '@/test-utils/workspace-snapshot';
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
    useRef: <T>(value: T) => ({ current: value }),
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
const mockGetData = vi.fn();
const mockWorkspaceGetSetData = vi.fn();
const mockListInvalidate = vi.fn();
const mockWorkspaceGetInvalidate = vi.fn();
const mockGlobalDispatchEvent = vi.fn();

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        listForProject: {
          setData: mockSetData,
          getData: mockGetData,
          invalidate: mockListInvalidate,
        },
        get: {
          setData: mockWorkspaceGetSetData,
          invalidate: mockWorkspaceGetInvalidate,
        },
      },
    }),
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('useProjectSnapshotSync', () => {
  beforeEach(() => {
    capturedOptions = null;
    mockSetData.mockReset();
    mockGetData.mockReset();
    // Most tests exercise the default 'ws-1' entry from makeEntry() and don't
    // care about the unknown-workspace invalidation this file also covers, so
    // seed the cache with that id by default. Tests that specifically exercise
    // an unknown workspace use a different id ('ws-new') that isn't seeded here.
    mockGetData.mockReturnValue({ workspaces: [{ id: 'ws-1' }], reviewCount: 0 });
    mockWorkspaceGetSetData.mockReset();
    // Real tRPC `invalidate` returns a promise; the repair path chains .catch()
    // onto it to release its guard when a refetch fails.
    mockListInvalidate.mockReset();
    mockListInvalidate.mockResolvedValue(undefined);
    mockWorkspaceGetInvalidate.mockClear();
    mockGlobalDispatchEvent.mockClear();
    resetPendingRatchetTogglesForTests();
    vi.stubGlobal('dispatchEvent', mockGlobalDispatchEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
  // Project workspace list cache (workspace.listForProject) — the one list the
  // sidebar and the Kanban board both read.
  // ===========================================================================

  describe('snapshot_full message', () => {
    it('calls setData with mapped entries and preserves reviewCount from prev when omitted', () => {
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

    it('uses reviewCount from the snapshot_full message when provided', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [],
        reviewCount: 9,
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater({ workspaces: [], reviewCount: 5 });
      expect(result.reviewCount).toBe(9);
      expect(result.workspaces).toHaveLength(0);
    });

    it('preserves existing DB-only fields while taking snapshot fields', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1', name: 'snapshot-name' });
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [entry],
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater({
        workspaces: [{ id: 'ws-1', githubIssueNumber: 42, name: 'stale-name' }],
        reviewCount: 0,
      });
      expect(result.workspaces[0].githubIssueNumber).toBe(42);
      expect(result.workspaces[0].name).toBe('snapshot-name');
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

  describe('snapshot_changed message', () => {
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

    it('updates reviewCount from the snapshot_changed message when provided', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
        reviewCount: 4,
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater({
        workspaces: [{ id: 'ws-1', name: 'existing' }],
        reviewCount: 8,
      });
      expect(result.reviewCount).toBe(4);
      expect(result.workspaces).toHaveLength(1);
    });

    it('does not overwrite existing DB-only fields during upsert', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      const entry = makeEntry({ workspaceId: 'ws-1' });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry,
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater({
        workspaces: [{ id: 'ws-1', name: 'old', githubIssueNumber: 42 }],
        reviewCount: 0,
      });
      expect(result.workspaces[0].githubIssueNumber).toBe(42);
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
      expect(result.workspaces[0].githubIssueNumber).toBeNull();
      expect(result.reviewCount).toBe(0);
    });
  });

  describe('snapshot_removed message', () => {
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

    it('updates reviewCount from the snapshot_removed message when provided', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
        reviewCount: 2,
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater({
        workspaces: [{ id: 'ws-1', name: 'gone' }],
        reviewCount: 7,
      });
      expect(result.reviewCount).toBe(2);
      expect(result.workspaces).toHaveLength(0);
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
  // Board membership is a client-side selector, not a second cache
  // ===========================================================================

  describe('workspaces the board excludes', () => {
    it('keeps an entry with a null kanbanColumn in the shared list', () => {
      // A null column means the board does not show the workspace (it is
      // archiving). The sidebar still does, so the entry stays in the one
      // cache and the board filters it out when it renders.
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [
          makeEntry({ workspaceId: 'ws-1', kanbanColumn: 'WORKING' }),
          makeEntry({ workspaceId: 'ws-2', kanbanColumn: null }),
        ],
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result.workspaces.map((w: { id: string }) => w.id)).toEqual(['ws-1', 'ws-2']);
      expect(result.workspaces[1].kanbanColumn).toBeNull();
    });
  });

  // ===========================================================================
  // Workspace detail cache tests (workspace.get)
  // ===========================================================================

  describe('workspace.get cache updates', () => {
    it('snapshot_full updates workspace.get cache entries', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1' }), makeEntry({ workspaceId: 'ws-2' })],
      });

      expect(mockWorkspaceGetSetData).toHaveBeenCalledTimes(2);
      expect(mockWorkspaceGetSetData).toHaveBeenNthCalledWith(
        1,
        { id: 'ws-1' },
        expect.any(Function)
      );
      expect(mockWorkspaceGetSetData).toHaveBeenNthCalledWith(
        2,
        { id: 'ws-2' },
        expect.any(Function)
      );
    });

    it('snapshot_changed updates the workspace.get cache entry', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', prCiStatus: 'PENDING' }),
      });

      expect(mockWorkspaceGetSetData).toHaveBeenCalledTimes(1);
      expect(mockWorkspaceGetSetData).toHaveBeenCalledWith({ id: 'ws-1' }, expect.any(Function));
    });

    it('snapshot_removed clears the workspace.get cache entry', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      });

      expect(mockWorkspaceGetSetData).toHaveBeenCalledTimes(1);
      expect(mockWorkspaceGetSetData).toHaveBeenCalledWith({ id: 'ws-1' }, undefined);
    });
  });

  // ===========================================================================
  // Merge strategy: deltas are pure patches, reconnect baseline heals
  // ===========================================================================

  function expectNoInvalidations(): void {
    expect(mockListInvalidate).not.toHaveBeenCalled();
    expect(mockWorkspaceGetInvalidate).not.toHaveBeenCalled();
  }

  describe('cache invalidation strategy', () => {
    it('snapshot_changed and snapshot_removed do not invalidate caches for a known workspace', () => {
      // Seed the list cache with the entry's workspace id so it is already
      // known; a *known* workspace's deltas never invalidate. An *unknown*
      // workspace is covered separately below.
      mockGetData.mockReturnValue({ workspaces: [{ id: 'ws-1' }], reviewCount: 0 });
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry(),
      });
      onMessage({
        type: 'snapshot_removed',
        workspaceId: 'ws-1',
      });

      expectNoInvalidations();
    });

    it('invalidates the project list once when snapshot_changed introduces an unknown workspace', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-new',
        entry: makeEntry({ workspaceId: 'ws-new' }),
      });
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-new',
        entry: makeEntry({ workspaceId: 'ws-new' }),
      });

      expect(mockListInvalidate).toHaveBeenCalledTimes(1);
      expect(mockListInvalidate).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });

    it('invalidates when snapshot_full introduces a workspace the cache has never seen', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-new' })],
      });

      expect(mockListInvalidate).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });

    it('the initial snapshot_full baseline does not invalidate caches', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry()],
      });

      expectNoInvalidations();
    });

    it('heals the workspace caches on every baseline after a project&apos;s first', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry()],
      });
      expectNoInvalidations();

      // A later baseline follows a gap (reconnect or project switch) during
      // which deltas were dropped, so it must heal.
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry()],
      });

      expect(mockWorkspaceGetInvalidate).toHaveBeenCalledTimes(1);
      expect(mockWorkspaceGetInvalidate).toHaveBeenCalledWith();
      expect(mockListInvalidate).toHaveBeenCalledTimes(1);
      expect(mockListInvalidate).toHaveBeenCalledWith({ projectId: 'proj-1' });

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry()],
      });
      expect(mockWorkspaceGetInvalidate).toHaveBeenCalledTimes(2);
      expect(mockListInvalidate).toHaveBeenCalledTimes(2);
    });

    it('tracks the first baseline per project', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [],
      });

      // Another project's first baseline neither heals nor counts as proj-1's.
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-2',
        entries: [],
      });
      expectNoInvalidations();

      // Returning to proj-1 (its second baseline) heals proj-1 only.
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [],
      });
      expect(mockListInvalidate).toHaveBeenCalledTimes(1);
      expect(mockListInvalidate).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });
  });

  // ===========================================================================
  // In-flight ratchet toggle overrides
  // ===========================================================================

  describe('unknown-workspace repair failure', () => {
    it('releases the guard so a later message can retry a failed repair', async () => {
      // Marking before the refetch collapses a burst of messages into one
      // request. If that request fails and the mark stayed, the workspace's
      // issue-link fields would stay null forever and its issue would sit in
      // Todo next to the board card.
      mockListInvalidate.mockRejectedValueOnce(new Error('network'));
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-new',
        entry: { ...makeEntry(), workspaceId: 'ws-new' },
      });
      await Promise.resolve();
      await Promise.resolve();

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-new',
        entry: { ...makeEntry(), workspaceId: 'ws-new' },
      });

      expect(mockListInvalidate).toHaveBeenCalledTimes(2);
    });
  });

  describe('pending ratchet toggle override', () => {
    it('snapshot_changed entries are overridden while a toggle is in flight', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      setPendingRatchetToggle('ws-1', false);
      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', ratchetEnabled: true, ratchetState: 'READY' }),
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result.workspaces[0].ratchetEnabled).toBe(false);
      expect(result.workspaces[0].ratchetState).toBe('IDLE');

      const [, detailUpdater] = mockWorkspaceGetSetData.mock.calls[0]!;
      const detail = detailUpdater({ id: 'ws-1' });
      expect(detail.ratchetEnabled).toBe(false);
    });

    it('snapshot_full entries are overridden while a toggle is in flight', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      setPendingRatchetToggle('ws-1', true);
      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1', ratchetEnabled: false })],
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result.workspaces[0].ratchetEnabled).toBe(true);
    });

    it('entries pass through untouched when no toggle is pending', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', ratchetEnabled: true, ratchetState: 'READY' }),
      });

      const [, updater] = mockSetData.mock.calls[0]!;
      const result = updater(undefined);
      expect(result.workspaces[0].ratchetEnabled).toBe(true);
      expect(result.workspaces[0].ratchetState).toBe('READY');
    });
  });

  describe('workspace attention events for pending requests', () => {
    it('does not dispatch attention during snapshot_full hydration', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1', pendingRequestType: 'plan_approval' })],
      });

      expect(mockGlobalDispatchEvent).not.toHaveBeenCalled();
    });

    it('dispatches attention on null to pending transition', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1', pendingRequestType: null })],
      });

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', pendingRequestType: 'user_question' }),
      });

      expect(mockGlobalDispatchEvent).toHaveBeenCalledTimes(1);
      expect(mockGlobalDispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workspace-attention-required',
          detail: { workspaceId: 'ws-1' },
        })
      );
    });

    it('dispatches attention on null to generic permission_request transition', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1', pendingRequestType: null })],
      });

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', pendingRequestType: 'permission_request' }),
      });

      expect(mockGlobalDispatchEvent).toHaveBeenCalledTimes(1);
      expect(mockGlobalDispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workspace-attention-required',
          detail: { workspaceId: 'ws-1' },
        })
      );
    });

    it('does not dispatch attention when pending type remains unchanged', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1', pendingRequestType: 'plan_approval' })],
      });

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', pendingRequestType: 'plan_approval' }),
      });

      expect(mockGlobalDispatchEvent).not.toHaveBeenCalled();
    });

    it('does not dispatch attention when pending request clears', () => {
      useProjectSnapshotSync('proj-1');
      const onMessage = capturedOptions!.onMessage!;

      onMessage({
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [makeEntry({ workspaceId: 'ws-1', pendingRequestType: 'plan_approval' })],
      });

      onMessage({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeEntry({ workspaceId: 'ws-1', pendingRequestType: null }),
      });

      expect(mockGlobalDispatchEvent).not.toHaveBeenCalled();
    });
  });
});
