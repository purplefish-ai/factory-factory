import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockApplyPrSnapshotWithDispatchReset = vi.fn();
const mockApplyCIObservationWithDispatchReset = vi.fn();
const mockAttachDiscoveredPRIfClaimMatches = vi.fn();
const mockUpdatePRSnapshotIfUrlMatches = vi.fn();
const mockFetchAndComputePRState = vi.fn();
const mockUpdateCachedKanbanColumn = vi.fn();

vi.mock('@/backend/services/workspace', () => ({
  workspaceAccessor: {
    findById: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    applyPrSnapshotWithDispatchReset: (...args: unknown[]) =>
      mockApplyPrSnapshotWithDispatchReset(...args),
    applyCIObservationWithDispatchReset: (...args: unknown[]) =>
      mockApplyCIObservationWithDispatchReset(...args),
    attachDiscoveredPRIfClaimMatches: (...args: unknown[]) =>
      mockAttachDiscoveredPRIfClaimMatches(...args),
    updatePRSnapshotIfUrlMatches: (...args: unknown[]) => mockUpdatePRSnapshotIfUrlMatches(...args),
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
  PR_DISPATCH_INVALIDATED,
  PR_SNAPSHOT_UPDATED,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from './pr-snapshot.service';

describe('PRSnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyPrSnapshotWithDispatchReset.mockResolvedValue(false);
    mockApplyCIObservationWithDispatchReset.mockResolvedValue(false);
    mockUpdatePRSnapshotIfUrlMatches.mockResolvedValue(true);
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
      expect(mockApplyPrSnapshotWithDispatchReset).toHaveBeenCalledWith('w1', {
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

  describe('attachDiscoveredPRAndRefresh', () => {
    const claim = {
      branchName: 'feature/pr-discovery',
      checkedAt: new Date('2026-07-17T12:00:00.000Z'),
      retryCount: 2,
      nextCheckAt: new Date('2026-07-17T12:06:00.000Z'),
    };

    it('does not attach or fetch when activity invalidated the discovery claim', async () => {
      mockAttachDiscoveredPRIfClaimMatches.mockResolvedValue(false);

      await expect(
        prSnapshotService.attachDiscoveredPRAndRefresh(
          'w1',
          'https://github.com/org/repo/pull/1',
          claim
        )
      ).resolves.toEqual({ success: false, reason: 'claim_stale' });

      expect(mockAttachDiscoveredPRIfClaimMatches).toHaveBeenCalledWith(
        'w1',
        'https://github.com/org/repo/pull/1',
        claim,
        expect.any(Date)
      );
      expect(mockFetchAndComputePRState).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockUpdateCachedKanbanColumn).not.toHaveBeenCalled();
    });

    it('refreshes the snapshot without correcting a newer branch after guarded attachment', async () => {
      mockAttachDiscoveredPRIfClaimMatches.mockResolvedValue(true);
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
        headRefName: 'feature/pr-discovery',
      });

      await expect(
        prSnapshotService.attachDiscoveredPRAndRefresh(
          'w1',
          'https://github.com/org/repo/pull/123',
          claim
        )
      ).resolves.toEqual({
        success: true,
        snapshot: {
          prNumber: 123,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
        },
      });

      expect(mockUpdatePRSnapshotIfUrlMatches).toHaveBeenCalledWith(
        'w1',
        'https://github.com/org/repo/pull/123',
        {
          prNumber: 123,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
        },
        expect.any(Date)
      );
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w1');
    });

    it('drops a fetched snapshot when the attached PR URL changed during the fetch', async () => {
      mockAttachDiscoveredPRIfClaimMatches.mockResolvedValue(true);
      mockFetchAndComputePRState.mockResolvedValue({
        prNumber: 123,
        prState: 'OPEN',
        prReviewState: 'APPROVED',
        prCiStatus: 'SUCCESS',
        headRefName: 'feature/pr-discovery',
      });
      mockUpdatePRSnapshotIfUrlMatches.mockResolvedValue(false);
      const listener = vi.fn();
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, listener);

      await expect(
        prSnapshotService.attachDiscoveredPRAndRefresh(
          'w1',
          'https://github.com/org/repo/pull/123',
          claim
        )
      ).resolves.toEqual({ success: false, reason: 'claim_stale' });

      expect(mockUpdatePRSnapshotIfUrlMatches).toHaveBeenCalledWith(
        'w1',
        'https://github.com/org/repo/pull/123',
        {
          prNumber: 123,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
        },
        expect.any(Date)
      );
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockUpdateCachedKanbanColumn).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();

      prSnapshotService.off(PR_SNAPSHOT_UPDATED, listener);
    });

    it('keeps the guarded PR attachment when snapshot fetch fails', async () => {
      mockAttachDiscoveredPRIfClaimMatches.mockResolvedValue(true);
      mockFetchAndComputePRState.mockResolvedValue(null);

      await expect(
        prSnapshotService.attachDiscoveredPRAndRefresh(
          'w1',
          'https://github.com/org/repo/pull/1',
          claim
        )
      ).resolves.toEqual({ success: false, reason: 'fetch_failed' });

      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w1');
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

      expect(mockApplyPrSnapshotWithDispatchReset).toHaveBeenCalledWith('w1', {
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

      expect(mockApplyPrSnapshotWithDispatchReset).toHaveBeenCalledWith('w2', {
        prNumber: 50,
        prState: 'MERGED',
        prReviewState: null,
        prCiStatus: 'SUCCESS',
        prUpdatedAt: expect.any(Date),
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w2');
    });
  });

  describe('recordCIObservation', () => {
    it('does not clear failure timestamp when failedAt is omitted', async () => {
      const observedAt = new Date('2026-02-11T00:00:00Z');

      await prSnapshotService.recordCIObservation('w-ci-1', {
        ciStatus: 'SUCCESS',
        observedAt,
      });

      expect(mockApplyCIObservationWithDispatchReset).toHaveBeenCalledWith('w-ci-1', {
        prCiStatus: 'SUCCESS',
        prUpdatedAt: observedAt,
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w-ci-1');
    });

    it('does not clear failure timestamp when failedAt is undefined', async () => {
      const observedAt = new Date('2026-02-11T01:00:00Z');

      await prSnapshotService.recordCIObservation('w-ci-2', {
        ciStatus: 'SUCCESS',
        failedAt: undefined,
        observedAt,
      });

      expect(mockApplyCIObservationWithDispatchReset).toHaveBeenCalledWith('w-ci-2', {
        prCiStatus: 'SUCCESS',
        prUpdatedAt: observedAt,
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w-ci-2');
    });

    it('clears failure timestamp when failedAt is null', async () => {
      const observedAt = new Date('2026-02-11T02:00:00Z');

      await prSnapshotService.recordCIObservation('w-ci-3', {
        ciStatus: 'SUCCESS',
        failedAt: null,
        observedAt,
      });

      expect(mockApplyCIObservationWithDispatchReset).toHaveBeenCalledWith('w-ci-3', {
        prCiStatus: 'SUCCESS',
        prCiFailedAt: null,
        prUpdatedAt: observedAt,
      });
      expect(mockUpdateCachedKanbanColumn).toHaveBeenCalledWith('w-ci-3');
    });
  });

  describe('event emission', () => {
    afterEach(() => {
      prSnapshotService.removeAllListeners();
    });

    it('invalidates dispatch ownership when a direct CI observation resets it', async () => {
      mockApplyCIObservationWithDispatchReset.mockResolvedValue(true);
      const events: Array<{ workspaceId: string }> = [];
      prSnapshotService.on(PR_DISPATCH_INVALIDATED, (event) => events.push(event));

      await prSnapshotService.recordCIObservation('ws-exhausted', {
        ciStatus: 'PENDING',
        observedAt: new Date('2026-07-17T12:00:00.000Z'),
      });

      expect(events).toEqual([{ workspaceId: 'ws-exhausted' }]);
    });

    it('publishes a direct CI reset before a cache refresh rejection', async () => {
      mockApplyCIObservationWithDispatchReset.mockResolvedValue(true);
      mockUpdateCachedKanbanColumn.mockRejectedValueOnce(new Error('cache failed'));
      const events: Array<{ workspaceId: string }> = [];
      prSnapshotService.on(PR_DISPATCH_INVALIDATED, (event) => events.push(event));

      await expect(
        prSnapshotService.recordCIObservation('ws-cache-failure', { ciStatus: 'PENDING' })
      ).rejects.toThrow('cache failed');

      expect(events).toEqual([{ workspaceId: 'ws-cache-failure' }]);
    });

    it('emits pr_snapshot_updated after successful applySnapshot', async () => {
      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      await prSnapshotService.applySnapshot(
        'ws-1',
        {
          prNumber: 42,
          prState: 'OPEN',
          prCiStatus: 'SUCCESS',
          prReviewState: null,
        },
        {
          eventPrUrl: 'https://github.com/org/repo/pull/42',
        }
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-1',
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        prReviewState: null,
      });
    });

    it('publishes an authoritative dispatch reset after the PR aggregate changes', async () => {
      mockApplyPrSnapshotWithDispatchReset.mockResolvedValue(true);
      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      await prSnapshotService.applySnapshot('ws-exhausted', {
        prNumber: 42,
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        prReviewState: 'CHANGES_REQUESTED',
      });

      expect(mockApplyPrSnapshotWithDispatchReset).toHaveBeenCalledWith(
        'ws-exhausted',
        expect.objectContaining({
          prNumber: 42,
          prState: 'OPEN',
          prCiStatus: 'PENDING',
          prReviewState: 'CHANGES_REQUESTED',
          prUpdatedAt: expect.any(Date),
        })
      );
      expect(events[0]).toMatchObject({ ratchetDispatchChanged: true });
    });

    it('does not publish a dispatch reset for an identical PR aggregate refresh', async () => {
      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      await prSnapshotService.applySnapshot('ws-identical', {
        prNumber: 42,
        prState: 'CHANGES_REQUESTED',
        prCiStatus: 'FAILURE',
        prReviewState: 'CHANGES_REQUESTED',
      });

      expect(events[0]).not.toHaveProperty('ratchetDispatchChanged');
    });

    it('does not include prUrl in event when applySnapshot is called without prUrl options', async () => {
      const events: PRSnapshotUpdatedEvent[] = [];
      prSnapshotService.on(PR_SNAPSHOT_UPDATED, (event: PRSnapshotUpdatedEvent) => {
        events.push(event);
      });

      await prSnapshotService.applySnapshot('ws-plain', {
        prNumber: 11,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        prReviewState: null,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        workspaceId: 'ws-plain',
        prNumber: 11,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        prReviewState: null,
      });
      expect(events[0]).not.toHaveProperty('prUrl');
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
        prUrl: 'https://github.com/org/repo/pull/10',
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
      mockFindById.mockResolvedValueOnce({ id: 'ws-attach', prUrl: null });
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
        prUrl: 'https://github.com/org/repo/pull/77',
        prNumber: 77,
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        prReviewState: null,
      });
    });
  });
});
