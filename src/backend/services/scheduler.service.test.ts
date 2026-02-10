import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindNeedingPRSync = vi.fn();
const mockFindNeedingPRDiscovery = vi.fn();
const mockWorkspaceUpdate = vi.fn();
const mockFindPRForBranch = vi.fn();
const mockRefreshWorkspace = vi.fn();
const mockAttachAndRefreshPR = vi.fn();

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findNeedingPRSync: () => mockFindNeedingPRSync(),
    findNeedingPRDiscovery: () => mockFindNeedingPRDiscovery(),
    update: (...args: unknown[]) => mockWorkspaceUpdate(...args),
  },
}));

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    findPRForBranch: (...args: unknown[]) => mockFindPRForBranch(...args),
  },
  prSnapshotService: {
    refreshWorkspace: (...args: unknown[]) => mockRefreshWorkspace(...args),
    attachAndRefreshPR: (...args: unknown[]) => mockAttachAndRefreshPR(...args),
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

import { schedulerService } from './scheduler.service';

describe('SchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  describe('syncPRStatuses', () => {
    it('returns zeros when no workspaces need sync', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 0 });
    });

    it('syncs workspaces via PR snapshot service', async () => {
      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
        { id: 'ws-2', prUrl: 'https://github.com/org/repo/pull/2' },
      ]);

      mockRefreshWorkspace.mockResolvedValue({
        success: true,
        snapshot: {
          prNumber: 1,
          prState: 'OPEN',
          prReviewState: null,
          prCiStatus: 'PENDING',
        },
      });

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 2, failed: 0 });
      expect(mockRefreshWorkspace).toHaveBeenCalledTimes(2);
    });

    it('counts failed syncs', async () => {
      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
        { id: 'ws-2', prUrl: null },
      ]);

      mockRefreshWorkspace.mockResolvedValue({ success: false, reason: 'fetch_failed' });

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 2 });
    });
  });

  describe('discoverNewPRs', () => {
    it('updates workspace prUrl and refreshes PR snapshot when PR is discovered', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature',
          project: { githubOwner: 'org', githubRepo: 'repo' },
        },
      ]);

      mockFindPRForBranch.mockResolvedValue({
        number: 101,
        url: 'https://github.com/org/repo/pull/101',
      });

      mockAttachAndRefreshPR.mockResolvedValue({
        success: true,
        snapshot: {
          prNumber: 101,
          prState: 'OPEN',
          prReviewState: null,
          prCiStatus: 'PENDING',
        },
      });

      const result = await schedulerService.discoverNewPRs();

      expect(result).toEqual({ discovered: 1, checked: 1 });
      expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
        'ws-1',
        'https://github.com/org/repo/pull/101'
      );
    });

    it('counts PR as discovered when attachment succeeds but snapshot fetch fails', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature',
          project: { githubOwner: 'org', githubRepo: 'repo' },
        },
      ]);

      mockFindPRForBranch.mockResolvedValue({
        number: 101,
        url: 'https://github.com/org/repo/pull/101',
      });

      mockAttachAndRefreshPR.mockResolvedValue({
        success: false,
        reason: 'fetch_failed',
      });

      const result = await schedulerService.discoverNewPRs();

      expect(result).toEqual({ discovered: 1, checked: 1 });
    });

    it('does not count PR as discovered when attachment fails entirely', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature',
          project: { githubOwner: 'org', githubRepo: 'repo' },
        },
      ]);

      mockFindPRForBranch.mockResolvedValue({
        number: 101,
        url: 'https://github.com/org/repo/pull/101',
      });

      mockAttachAndRefreshPR.mockResolvedValue({
        success: false,
        reason: 'workspace_not_found',
      });

      const result = await schedulerService.discoverNewPRs();

      expect(result).toEqual({ discovered: 0, checked: 1 });
    });
  });

  describe('interval behavior', () => {
    it('runs periodic sync/discovery after start', async () => {
      mockFindNeedingPRSync.mockResolvedValue([]);
      mockFindNeedingPRDiscovery.mockResolvedValue([]);

      schedulerService.start();
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // Updated to 3 minutes to match new polling interval

      expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(1);
      expect(mockFindNeedingPRDiscovery).toHaveBeenCalledTimes(1);

      await schedulerService.stop();
    });
  });
});
