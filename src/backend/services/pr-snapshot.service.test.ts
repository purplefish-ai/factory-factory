import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockFetchAndComputePRState = vi.fn();
const mockUpdateCachedKanbanColumn = vi.fn();

vi.mock('../resource_accessors/workspace.accessor', () => ({
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

vi.mock('./kanban-state.service', () => ({
  kanbanStateService: {
    updateCachedKanbanColumn: (...args: unknown[]) => mockUpdateCachedKanbanColumn(...args),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { prSnapshotService } from './pr-snapshot.service';

describe('PRSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
