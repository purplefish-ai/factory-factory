import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';

const mockFindNeedingPRSync = vi.fn();
const mockFindNeedingPRDiscovery = vi.fn();
const mockWorkspaceUpdate = vi.fn();
const mockFindPRForBranch = vi.fn();
const mockRefreshWorkspace = vi.fn();
const mockAttachAndRefreshPR = vi.fn();

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
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

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { schedulerService } from './scheduler.service';

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    promise,
    resolve: (value: T) => resolve?.(value),
  };
}

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
      const workspaceCreatedAt = new Date('2024-01-01T00:00:00Z');
      mockFindNeedingPRDiscovery.mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature',
          createdAt: workspaceCreatedAt,
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
      expect(mockFindPRForBranch).toHaveBeenCalledWith(
        'org',
        'repo',
        'feature',
        workspaceCreatedAt
      );
      expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
        'ws-1',
        'https://github.com/org/repo/pull/101'
      );
    });

    it('counts PR as discovered when attachment succeeds but snapshot fetch fails', async () => {
      const workspaceCreatedAt = new Date('2024-01-01T00:00:00Z');
      mockFindNeedingPRDiscovery.mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature',
          createdAt: workspaceCreatedAt,
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
      const workspaceCreatedAt = new Date('2024-01-01T00:00:00Z');
      mockFindNeedingPRDiscovery.mockResolvedValue([
        {
          id: 'ws-1',
          branchName: 'feature',
          createdAt: workspaceCreatedAt,
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
      await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.schedulerPrSync);

      expect(mockFindNeedingPRSync).toHaveBeenCalledTimes(1);
      expect(mockFindNeedingPRDiscovery).toHaveBeenCalledTimes(1);

      await schedulerService.stop();
    });

    it('does not overlap periodic batches when previous tick is still running', async () => {
      const deferredSync = createDeferred<{
        success: boolean;
        snapshot: { prNumber: number; prState: string; prReviewState: null; prCiStatus: string };
      }>();

      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://example.com/pull/1' },
      ]);
      mockFindNeedingPRDiscovery.mockResolvedValue([]);
      mockRefreshWorkspace.mockImplementation(() => deferredSync.promise);

      schedulerService.start();

      await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.schedulerPrSync);
      await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.schedulerPrSync);

      const syncCalls = mockFindNeedingPRSync.mock.calls.length;
      const discoveryCalls = mockFindNeedingPRDiscovery.mock.calls.length;
      const refreshCalls = mockRefreshWorkspace.mock.calls.length;

      deferredSync.resolve({
        success: true,
        snapshot: {
          prNumber: 1,
          prState: 'OPEN',
          prReviewState: null,
          prCiStatus: 'PENDING',
        },
      });

      await schedulerService.stop();

      expect(syncCalls).toBe(1);
      expect(discoveryCalls).toBe(1);
      expect(refreshCalls).toBe(1);
    });

    it('waits for in-flight sync work before stopping', async () => {
      const deferredSync = createDeferred<{
        success: boolean;
        snapshot: { prNumber: number; prState: string; prReviewState: null; prCiStatus: string };
      }>();

      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://example.com/pull/1' },
      ]);
      mockFindNeedingPRDiscovery.mockResolvedValue([]);
      mockRefreshWorkspace.mockImplementation(() => deferredSync.promise);

      schedulerService.start();
      await vi.advanceTimersByTimeAsync(SERVICE_INTERVAL_MS.schedulerPrSync);

      let stopped = false;
      const stopPromise = schedulerService.stop().then(() => {
        stopped = true;
      });

      await Promise.resolve();
      expect(stopped).toBe(false);

      deferredSync.resolve({
        success: true,
        snapshot: {
          prNumber: 1,
          prState: 'OPEN',
          prReviewState: null,
          prCiStatus: 'PENDING',
        },
      });

      await stopPromise;
      expect(stopped).toBe(true);
    });
  });
});
