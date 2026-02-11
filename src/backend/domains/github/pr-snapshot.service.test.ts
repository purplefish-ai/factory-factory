import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockFetchAndComputePRState = vi.fn();
const mockUpdateCachedKanbanColumn = vi.fn();

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    fetchAndComputePRState: (...args: unknown[]) => mockFetchAndComputePRState(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  PR_SNAPSHOT_UPDATED,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from './pr-snapshot.service';

describe('PRSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Configure bridge with mock kanban dependency
    prSnapshotService.configure({
      kanban: {
        updateCachedKanbanColumn: (...args: unknown[]) => mockUpdateCachedKanbanColumn(...args),
      },
    });
  });

  describe('attachAndRefreshPR', () => {
    it('returns workspace_not_found when workspace does not exist', async () => {
      mockFindById.mockResolvedValue(null);

      const result = await prSnapshotService.attachAndRefreshPR(
        'w1',
        'https://github.com/org/repo/pull/1'
      );

      expect(result).toEqual({ success: false, reason: 'workspace_not_found' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockUpdateCachedKanbanColumn).not.toHaveBeenCalled();
    });

    it('attaches PR URL even when snapshot fetch fails', async () => {
      mockFindById.mockResolvedValue({ id: 'w1', prUrl: null });
      mockFetchAndComputePRState.mockResolvedValue(null);

      const result = await prSnapshotService.attachAndRefreshPR(
        'w1',
        'https://github.com/org/repo/pull/1'
      );

      expect(result).toEqual({ success: false, reason: 'fetch_failed' });
      expect(mockUpdate).toHaveBeenCalledWith('w1', {
        prUrl: 'https://github.com/org/repo/pull/1',
        prUpdatedAt: expect.any(Date),
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w1');
    });

    it('attaches PR URL and persists full snapshot with kanban cache update', async () => {
      mockFindById.mockResolvedValue({ id: 'w1', prUrl: null });
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
      });

      const result = await prSnapshotService.attachAndRefreshPR(
        'w1',
        'https://github.com/org/repo/pull/123'
      );

      expect(result).toEqual({
        success: true,
        snapshot: {
          prNumber: 123,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
        },
      });

      // Verify atomic update with all PR fields including prUrl
      expect(mockUpdate).toHaveBeenCalledWith('w1', {
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
        prUrl: 'https://github.com/org/repo/pull/123',
        prUpdatedAt: expect.any(Date),
      });

      // Verify kanban cache update
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w1');
    });

    it('handles errors gracefully', async () => {
      mockFindById.mockRejectedValue(new Error('Database error'));

      const result = await prSnapshotService.attachAndRefreshPR(
        'w1',
        'https://github.com/org/repo/pull/1'
      );

      expect(result).toEqual({ success: false, reason: 'error' });
    });
  });

  describe('refreshWorkspace', () => {
    it('returns workspace_not_found when workspace does not exist', async () => {
      mockFindById.mockResolvedValue(null);

      const result = await prSnapshotService.refreshWorkspace('w1');

      expect(result).toEqual({ success: false, reason: 'workspace_not_found' });
    });

    it('returns no_pr_url when workspace has no PR URL', async () => {
      mockFindById.mockResolvedValue({ id: 'w1', prUrl: null });

      const result = await prSnapshotService.refreshWorkspace('w1');

      expect(result).toEqual({ success: false, reason: 'no_pr_url' });
    });

    it('returns fetch_failed when GitHub snapshot is unavailable', async () => {
      mockFindById.mockResolvedValue({ id: 'w1', prUrl: 'https://github.com/org/repo/pull/1' });
      mockFetchAndComputePRState.mockResolvedValue(null);

      const result = await prSnapshotService.refreshWorkspace('w1');

      expect(result).toEqual({ success: false, reason: 'fetch_failed' });
    });

    it('persists PR snapshot and updates kanban cache', async () => {
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
      });

      const result = await prSnapshotService.refreshWorkspace(
        'w1',
        'https://github.com/org/repo/pull/123'
      );

      expect(result).toEqual({
        success: true,
        snapshot: {
          prNumber: 123,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
        },
      });

      expect(mockUpdate).toHaveBeenCalledWith('w1', {
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
        prUpdatedAt: expect.any(Date),
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w1');
    });

    it('applies snapshot directly through shared write path', async () => {
      await prSnapshotService.applySnapshot('w2', {
        prNumber: 50,
        prState: 'MERGED',
        prReviewState: null,
        prCiStatus: 'SUCCESS',
      });

      expect(mockUpdate).toHaveBeenCalledWith('w2', {
        prNumber: 50,
        prState: 'MERGED',
        prReviewState: null,
        prCiStatus: 'SUCCESS',
        prUpdatedAt: expect.any(Date),
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w2');
    });
  });

  describe('event emission', () => {
    afterEach(() => {
      prSnapshotService.removeAllListeners();
    });

    it('emits pr_snapshot_updated after successful applySnapshot', async () => {
      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      await prSnapshotService.applySnapshot('ws-1', {
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        prReviewState: null,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        prReviewState: null,
      });
    });

    it('emits pr_snapshot_updated on refreshWorkspace when snapshot succeeds', async () => {
      mockFindById.mockResolvedValue({
        id: 'ws-2',
        prUrl: 'https://github.com/org/repo/pull/10',
      });
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 10,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'FAILURE',
      });

      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      const result = await prSnapshotService.refreshWorkspace('ws-2');

      expect(result).toEqual({
        success: true,
        snapshot: {
          prNumber: 10,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'FAILURE',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-2',
        prNumber: 10,
        prState: 'OPEN',
        prCiStatus: 'FAILURE',
        prReviewState: 'APPROVED',
      });
    });

    it('does NOT emit on refreshWorkspace when workspace not found', async () => {
      mockFindById.mockResolvedValue(null);

      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      await prSnapshotService.refreshWorkspace('ws-missing');

      expect(events).toHaveLength(0);
    });

    it('does NOT emit on refreshWorkspace when no prUrl', async () => {
      mockFindById.mockResolvedValue({ id: 'ws-no-pr', prUrl: null });

      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      const result = await prSnapshotService.refreshWorkspace('ws-no-pr');

      expect(result).toEqual({ success: false, reason: 'no_pr_url' });
      expect(events).toHaveLength(0);
    });

    it('emits event on attachAndRefreshPR', async () => {
      mockFindById.mockResolvedValue({ id: 'ws-attach', prUrl: null });
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 77,
        prState: 'OPEN',
        prReviewState: null,
        prCiStatus: 'PENDING',
      });

      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      const result = await prSnapshotService.attachAndRefreshPR(
        'ws-attach',
        'https://github.com/org/repo/pull/77'
      );

      expect(result).toEqual({
        success: true,
        snapshot: {
          prNumber: 77,
          prState: 'OPEN',
          prReviewState: null,
          prCiStatus: 'PENDING',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-attach',
        prNumber: 77,
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        prReviewState: null,
      });
    });
  });
});
