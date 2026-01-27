import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing the service
const mockFindNeedingPRSync = vi.fn();
const mockUpdate = vi.fn();
const mockFetchAndComputePRState = vi.fn();
const mockUpdateCachedKanbanColumn = vi.fn();

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findNeedingPRSync: () => mockFindNeedingPRSync(),
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

// Import after mocks are set up
import { schedulerService } from './scheduler.service';

describe('SchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  // Note: We can't easily reset the singleton's internal state,
  // so tests need to be careful about order and cleanup

  describe('syncPRStatuses', () => {
    it('should return zeros when no workspaces need sync', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 0 });
      expect(mockFindNeedingPRSync).toHaveBeenCalled();
    });

    it('should sync workspaces and return counts', async () => {
      const mockWorkspaces = [
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
        { id: 'ws-2', prUrl: 'https://github.com/org/repo/pull/2' },
      ];

      mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 1,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
      });
      mockUpdate.mockResolvedValue({});
      mockUpdateCachedKanbanColumn.mockResolvedValue(undefined);

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 2, failed: 0 });
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledTimes(2);
    });

    it('should count failed syncs separately', async () => {
      const mockWorkspaces = [
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
        { id: 'ws-2', prUrl: 'https://github.com/org/repo/pull/2' },
        { id: 'ws-3', prUrl: null }, // No PR URL - will fail
      ];

      mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);
      mockFetchAndComputePRState
        .mockResolvedValueOnce({
          prNumber: 1,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
        })
        .mockResolvedValueOnce(null); // Second call fails

      mockUpdate.mockResolvedValue({});
      mockUpdateCachedKanbanColumn.mockResolvedValue(undefined);

      const result = await schedulerService.syncPRStatuses();

      // 1 success, 1 fetch failed, 1 no PR URL
      expect(result).toEqual({ synced: 1, failed: 2 });
    });

    it('should handle exceptions during sync gracefully', async () => {
      const mockWorkspaces = [{ id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' }];

      mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);
      mockFetchAndComputePRState.mockRejectedValue(new Error('Network error'));

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 1 });
    });

    it('should respect rate limit of 5 concurrent syncs', async () => {
      // Create 10 workspaces
      const mockWorkspaces = Array.from({ length: 10 }, (_, i) => ({
        id: `ws-${i}`,
        prUrl: `https://github.com/org/repo/pull/${i}`,
      }));

      mockFindNeedingPRSync.mockResolvedValue(mockWorkspaces);
      mockUpdate.mockResolvedValue({});
      mockUpdateCachedKanbanColumn.mockResolvedValue(undefined);

      // Track concurrent calls
      let currentConcurrent = 0;
      let maxConcurrent = 0;

      mockFetchAndComputePRState.mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));

        currentConcurrent--;
        return {
          prNumber: 1,
          prState: 'OPEN',
          prReviewState: null,
        };
      });

      // Use real timers for this test since we need actual async behavior
      vi.useRealTimers();

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 10, failed: 0 });
      expect(maxConcurrent).toBeLessThanOrEqual(5);
      expect(maxConcurrent).toBeGreaterThan(0);

      // Restore fake timers for other tests
      vi.useFakeTimers();
    });
  });

  describe('single PR sync', () => {
    it('should update workspace with PR status on success', async () => {
      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/123' },
      ]);

      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 123,
        prState: 'MERGED',
        prReviewState: 'APPROVED',
      });

      mockUpdate.mockResolvedValue({});
      mockUpdateCachedKanbanColumn.mockResolvedValue(undefined);

      await schedulerService.syncPRStatuses();

      expect(mockUpdate).toHaveBeenCalledWith('ws-1', {
        prNumber: 123,
        prState: 'MERGED',
        prReviewState: 'APPROVED',
        prUpdatedAt: expect.any(Date),
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('ws-1');
    });

    it('should skip workspaces with null prUrl', async () => {
      mockFindNeedingPRSync.mockResolvedValue([{ id: 'ws-1', prUrl: null }]);

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 1 });
      expect(mockFetchAndComputePRState).not.toHaveBeenCalled();
    });

    it('should handle null response from GitHub API', async () => {
      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
      ]);

      mockFetchAndComputePRState.mockResolvedValue(null);

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 1 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('start/stop lifecycle', () => {
    it('should not throw when stop is called without start', async () => {
      // This should not throw
      await schedulerService.stop();
    });

    it('should start and stop without errors', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      schedulerService.start();
      await schedulerService.stop();
    });

    it('should be safe to call start twice', () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      schedulerService.start();
      schedulerService.start(); // Should be no-op

      // Clean up
      schedulerService.stop();
    });

    it('should be safe to call stop twice', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      schedulerService.start();
      await schedulerService.stop();
      await schedulerService.stop(); // Should be no-op
    });
  });

  describe('interval behavior', () => {
    it('should run sync every 5 minutes when started', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      schedulerService.start();

      // Initial state - no calls yet
      expect(mockFindNeedingPRSync).not.toHaveBeenCalled();

      // First interval tick (5 minutes)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(1);

      // Second interval tick
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(2);

      await schedulerService.stop();
    });

    it('should not run sync after stop', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      schedulerService.start();
      await schedulerService.stop();

      // Clear any calls from start
      mockFindNeedingPRSync.mockClear();

      // Advance time - should not trigger sync
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(mockFindNeedingPRSync).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should catch and continue after errors in batch sync', async () => {
      // First call fails
      mockFindNeedingPRSync.mockRejectedValueOnce(new Error('Database error'));
      // Second call succeeds
      mockFindNeedingPRSync.mockResolvedValueOnce([]);

      schedulerService.start();

      // First tick - should fail but not crash
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Second tick - should still work
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(2);

      await schedulerService.stop();
    });
  });
});
