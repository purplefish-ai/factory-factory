import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';

const mockFindNeedingPRSync = vi.fn();
const mockFindNeedingPRDiscovery = vi.fn();
const mockClaimPRDiscoveryAttempt = vi.fn();
const mockListOpenPRs = vi.fn();
const mockRefreshWorkspace = vi.fn();
const mockAttachAndRefreshPR = vi.fn();
const mockGetPRDiscoveryLimits = vi.fn();

vi.mock('@/backend/services/workspace', () => ({
  computePRDiscoveryNextCheckAt: (date: Date, retryCount: number) =>
    new Date(date.getTime() + retryCount * 60_000),
  workspaceAccessor: {
    findNeedingPRSync: () => mockFindNeedingPRSync(),
    findNeedingPRDiscovery: (...args: unknown[]) => mockFindNeedingPRDiscovery(...args),
    claimPRDiscoveryAttempt: (...args: unknown[]) => mockClaimPRDiscoveryAttempt(...args),
  },
}));

vi.mock('@/backend/services/config.service', () => ({
  configService: {
    getPRDiscoveryLimits: () => mockGetPRDiscoveryLimits(),
  },
}));

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    listOpenPRs: (...args: unknown[]) => mockListOpenPRs(...args),
  },
  prSnapshotService: {
    refreshWorkspace: (...args: unknown[]) => mockRefreshWorkspace(...args),
    attachAndRefreshPR: (...args: unknown[]) => mockAttachAndRefreshPR(...args),
  },
  prFetchRegistry: {
    isRecentlyFetched: () => false,
    startFetch: vi.fn(() => 41),
    cancelFetch: vi.fn(),
    register: vi.fn(),
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

import { prFetchRegistry } from '@/backend/services/github';
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

const checkedAt = new Date('2026-07-17T12:00:00.000Z');

function discoveryWorkspace({
  id,
  owner = 'org',
  repo = 'repo',
  branch = 'feature',
  createdAt = new Date('2026-07-17T10:00:00.000Z'),
  updatedAt = new Date('2026-07-17T11:00:00.000Z'),
  retryCount = 0,
  nextCheckAt = null,
}: {
  id: string;
  owner?: string;
  repo?: string;
  branch?: string;
  createdAt?: Date;
  updatedAt?: Date;
  retryCount?: number;
  nextCheckAt?: Date | null;
}) {
  return {
    id,
    branchName: branch,
    createdAt,
    updatedAt,
    prDiscoveryRetryCount: retryCount,
    prDiscoveryNextCheckAt: nextCheckAt,
    project: { githubOwner: owner, githubRepo: repo },
  };
}

describe('SchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(checkedAt);
    vi.clearAllMocks();
    mockGetPRDiscoveryLimits.mockReturnValue({ candidateLimit: 100, repositoryLimit: 10 });
    mockClaimPRDiscoveryAttempt.mockResolvedValue(true);
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
      expect(prFetchRegistry.startFetch).toHaveBeenCalledTimes(2);
      expect(prFetchRegistry.register).toHaveBeenNthCalledWith(1, 'ws-1', 41);
      expect(prFetchRegistry.register).toHaveBeenNthCalledWith(2, 'ws-2', 41);
    });

    it('counts failed syncs', async () => {
      mockFindNeedingPRSync.mockResolvedValue([
        { id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' },
        { id: 'ws-2', prUrl: null },
      ]);

      mockRefreshWorkspace.mockResolvedValue({ success: false, reason: 'fetch_failed' });

      const result = await schedulerService.syncPRStatuses();

      expect(result).toEqual({ synced: 0, failed: 2 });
      expect(prFetchRegistry.cancelFetch).toHaveBeenCalledWith('ws-1', 41);
    });
  });

  describe('discoverNewPRs', () => {
    it('claims and checks multiple workspaces through one case-insensitive repository batch', async () => {
      const nextCheckAt = new Date('2026-07-17T11:55:00.000Z');
      mockFindNeedingPRDiscovery.mockResolvedValue([
        discoveryWorkspace({ id: 'ws-1', owner: 'Owner', repo: 'Repo', branch: 'one' }),
        discoveryWorkspace({
          id: 'ws-2',
          owner: 'owner',
          repo: 'repo',
          branch: 'two',
          retryCount: 1,
          nextCheckAt,
        }),
      ]);
      mockListOpenPRs.mockResolvedValue([
        {
          number: 1,
          url: 'https://github.com/Owner/Repo/pull/1',
          createdAt: '2026-07-17T11:30:00.000Z',
          headRefName: 'one',
        },
        {
          number: 2,
          url: 'https://github.com/Owner/Repo/pull/2',
          createdAt: '2026-07-17T11:31:00.000Z',
          headRefName: 'two',
        },
      ]);
      mockAttachAndRefreshPR.mockResolvedValue({ success: true, snapshot: { prNumber: 1 } });

      await expect(schedulerService.discoverNewPRs()).resolves.toEqual({
        discovered: 2,
        checked: 2,
      });

      expect(mockFindNeedingPRDiscovery).toHaveBeenCalledWith(100, checkedAt);
      expect(mockClaimPRDiscoveryAttempt).toHaveBeenCalledTimes(2);
      expect(mockClaimPRDiscoveryAttempt).toHaveBeenCalledWith(
        'ws-2',
        expect.objectContaining({
          branchName: 'two',
          expectedRetryCount: 1,
          expectedNextCheckAt: nextCheckAt,
          checkedAt,
          nextCheckAt: expect.any(Date),
        })
      );
      expect(mockListOpenPRs).toHaveBeenCalledTimes(1);
      expect(mockListOpenPRs).toHaveBeenCalledWith('Owner', 'Repo');
      expect(Math.max(...mockClaimPRDiscoveryAttempt.mock.invocationCallOrder)).toBeLessThan(
        mockListOpenPRs.mock.invocationCallOrder[0] ?? 0
      );
    });

    it('caps repository groups and only claims selected candidates', async () => {
      mockGetPRDiscoveryLimits.mockReturnValue({ candidateLimit: 25, repositoryLimit: 1 });
      mockFindNeedingPRDiscovery.mockResolvedValue([
        discoveryWorkspace({ id: 'selected', repo: 'first' }),
        discoveryWorkspace({ id: 'limited', repo: 'second' }),
      ]);
      mockListOpenPRs.mockResolvedValue([]);

      await expect(schedulerService.discoverNewPRs()).resolves.toEqual({
        discovered: 0,
        checked: 1,
      });

      expect(mockFindNeedingPRDiscovery).toHaveBeenCalledWith(25, checkedAt);
      expect(mockClaimPRDiscoveryAttempt).toHaveBeenCalledTimes(1);
      expect(mockClaimPRDiscoveryAttempt).toHaveBeenCalledWith('selected', expect.any(Object));
      expect(mockListOpenPRs).toHaveBeenCalledWith('org', 'first');
    });

    it('skips repository I/O when none of its candidates can be claimed', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([discoveryWorkspace({ id: 'stale' })]);
      mockClaimPRDiscoveryAttempt.mockResolvedValue(false);

      await expect(schedulerService.discoverNewPRs()).resolves.toEqual({
        discovered: 0,
        checked: 0,
      });
      expect(mockListOpenPRs).not.toHaveBeenCalled();
    });

    it('isolates a repository failure and keeps checking other repositories', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        discoveryWorkspace({ id: 'failed', repo: 'broken', branch: 'same' }),
        discoveryWorkspace({ id: 'found', repo: 'working', branch: 'same' }),
      ]);
      mockListOpenPRs.mockImplementation((_owner: string, repo: string) => {
        if (repo === 'broken') {
          return Promise.reject(new Error('repository unavailable'));
        }
        return Promise.resolve([
          {
            number: 2,
            url: 'https://github.com/org/working/pull/2',
            createdAt: '2026-07-17T11:30:00.000Z',
            headRefName: 'same',
          },
        ]);
      });
      mockAttachAndRefreshPR.mockResolvedValue({ success: true, snapshot: { prNumber: 2 } });

      await expect(schedulerService.discoverNewPRs()).resolves.toEqual({
        discovered: 1,
        checked: 2,
      });
      expect(mockListOpenPRs).toHaveBeenCalledTimes(2);
      expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
        'found',
        'https://github.com/org/working/pull/2'
      );
    });

    it('keeps identical branch names isolated by repository', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        discoveryWorkspace({ id: 'ws-a', repo: 'a', branch: 'shared' }),
        discoveryWorkspace({ id: 'ws-b', repo: 'b', branch: 'shared' }),
      ]);
      mockListOpenPRs.mockImplementation((_owner: string, repo: string) =>
        Promise.resolve([
          {
            number: repo === 'a' ? 1 : 2,
            url: `https://github.com/org/${repo}/pull/${repo === 'a' ? 1 : 2}`,
            createdAt: '2026-07-17T11:30:00.000Z',
            headRefName: 'shared',
          },
        ])
      );
      mockAttachAndRefreshPR.mockResolvedValue({ success: true, snapshot: { prNumber: 1 } });

      await schedulerService.discoverNewPRs();

      expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
        'ws-a',
        'https://github.com/org/a/pull/1'
      );
      expect(mockAttachAndRefreshPR).toHaveBeenCalledWith(
        'ws-b',
        'https://github.com/org/b/pull/2'
      );
    });

    it('matches same-branch PRs one-to-one in chronological workspace order', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        discoveryWorkspace({
          id: 'newer-workspace',
          branch: 'reused',
          createdAt: new Date('2026-07-17T10:30:00.000Z'),
        }),
        discoveryWorkspace({
          id: 'older-workspace',
          branch: 'reused',
          createdAt: new Date('2026-07-17T10:00:00.000Z'),
        }),
      ]);
      mockListOpenPRs.mockResolvedValue([
        {
          number: 2,
          url: 'https://github.com/org/repo/pull/2',
          createdAt: '2026-07-17T11:00:00.000Z',
          headRefName: 'reused',
        },
        {
          number: 1,
          url: 'https://github.com/org/repo/pull/1',
          createdAt: '2026-07-17T10:15:00.000Z',
          headRefName: 'reused',
        },
      ]);
      mockAttachAndRefreshPR.mockResolvedValue({ success: true, snapshot: { prNumber: 1 } });

      await schedulerService.discoverNewPRs();

      expect(mockAttachAndRefreshPR.mock.calls).toEqual([
        ['older-workspace', 'https://github.com/org/repo/pull/1'],
        ['newer-workspace', 'https://github.com/org/repo/pull/2'],
      ]);
    });

    it('ignores PRs created before a workspace and branch names with different casing', async () => {
      mockFindNeedingPRDiscovery.mockResolvedValue([
        discoveryWorkspace({
          id: 'ws-1',
          branch: 'Feature',
          createdAt: new Date('2026-07-17T11:00:00.000Z'),
        }),
      ]);
      mockListOpenPRs.mockResolvedValue([
        {
          number: 1,
          url: 'https://github.com/org/repo/pull/1',
          createdAt: '2026-07-17T10:59:00.000Z',
          headRefName: 'Feature',
        },
        {
          number: 2,
          url: 'https://github.com/org/repo/pull/2',
          createdAt: '2026-07-17T11:30:00.000Z',
          headRefName: 'feature',
        },
      ]);

      await expect(schedulerService.discoverNewPRs()).resolves.toEqual({
        discovered: 0,
        checked: 1,
      });
      expect(mockListOpenPRs).toHaveBeenCalledWith('org', 'repo');
      expect(mockAttachAndRefreshPR).not.toHaveBeenCalled();
    });

    it.each([
      [{ success: false, reason: 'fetch_failed' }, 1],
      [{ success: false, reason: 'workspace_not_found' }, 0],
    ])('counts attachment result %o as %i discoveries', async (attachment, discovered) => {
      mockFindNeedingPRDiscovery.mockResolvedValue([discoveryWorkspace({ id: 'ws-1' })]);
      mockListOpenPRs.mockResolvedValue([
        {
          number: 1,
          url: 'https://github.com/org/repo/pull/1',
          createdAt: '2026-07-17T11:30:00.000Z',
          headRefName: 'feature',
        },
      ]);
      mockAttachAndRefreshPR.mockResolvedValue(attachment);

      await expect(schedulerService.discoverNewPRs()).resolves.toEqual({ discovered, checked: 1 });
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
