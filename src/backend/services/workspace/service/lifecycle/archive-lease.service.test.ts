import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accessor = vi.hoisted(() => ({
  claimArchiving: vi.fn<(id: string, expected: Date, claimedAt: Date) => Promise<boolean>>(),
  renewArchiving: vi.fn<(id: string, renewedAt: Date) => Promise<boolean>>(),
}));
const findStaleArchivingIds = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/workspace/resources/workspace-archive-recovery.accessor', () => ({
  workspaceArchiveRecoveryAccessor: accessor,
}));
vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: { findStaleArchivingIds },
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  ARCHIVE_LEASE_RENEW_MS,
  ARCHIVE_LEASE_STALE_MS,
  workspaceArchiveLeaseService,
} from './archive-lease.service';

const now = new Date('2026-11-25T12:00:00Z');

describe('workspaceArchiveLeaseService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    accessor.claimArchiving.mockResolvedValue(true);
    accessor.renewArchiving.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps a lease renewed within the threshold fresh, and an older one stale', () => {
    const leaseAge = (ms: number) =>
      workspaceArchiveLeaseService.isStale(new Date(now.getTime() - ms));
    expect(leaseAge(ARCHIVE_LEASE_STALE_MS - 1)).toBe(false);
    expect(leaseAge(ARCHIVE_LEASE_STALE_MS)).toBe(true);
    // A live archive renews several times within the threshold.
    expect(ARCHIVE_LEASE_STALE_MS / ARCHIVE_LEASE_RENEW_MS).toBeGreaterThanOrEqual(4);
  });

  it('lists the oldest rows written at or before the threshold', async () => {
    findStaleArchivingIds.mockResolvedValue([]);
    await workspaceArchiveLeaseService.findStaleIds(7);
    expect(findStaleArchivingIds).toHaveBeenCalledWith(
      new Date(now.getTime() - ARCHIVE_LEASE_STALE_MS),
      7
    );
  });

  it('claims with a compare-and-swap that always moves the stamp forward', async () => {
    const future = new Date(now.getTime() + 5000);
    const stamp = await workspaceArchiveLeaseService.claim('ws', future);
    expect(stamp?.getTime()).toBe(future.getTime() + 1);
    expect(accessor.claimArchiving).toHaveBeenCalledWith('ws', future, stamp);

    const old = new Date(0);
    expect(await workspaceArchiveLeaseService.claim('ws', old)).toEqual(now);
  });

  it('returns no stamp when another claimer moved the row first', async () => {
    accessor.claimArchiving.mockResolvedValueOnce(false);
    await expect(workspaceArchiveLeaseService.claim('ws', new Date(0))).resolves.toBeNull();
  });

  it('renews while held and stops once released', async () => {
    const lease = workspaceArchiveLeaseService.hold('ws', new Date(0));
    expect(accessor.renewArchiving).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ARCHIVE_LEASE_RENEW_MS);
    expect(accessor.renewArchiving).toHaveBeenCalledExactlyOnceWith(
      'ws',
      new Date(now.getTime() + ARCHIVE_LEASE_RENEW_MS)
    );
    expect(lease.stamp).toEqual(new Date(now.getTime() + ARCHIVE_LEASE_RENEW_MS));

    await vi.advanceTimersByTimeAsync(ARCHIVE_LEASE_RENEW_MS);
    expect(accessor.renewArchiving).toHaveBeenCalledTimes(2);

    await expect(lease.release()).resolves.toEqual(
      new Date(now.getTime() + 2 * ARCHIVE_LEASE_RENEW_MS)
    );
    await vi.advanceTimersByTimeAsync(5 * ARCHIVE_LEASE_RENEW_MS);
    expect(accessor.renewArchiving).toHaveBeenCalledTimes(2);
  });

  it('waits for a renewal in flight on release and never overlaps renewals', async () => {
    let finishRenewal!: (renewed: boolean) => void;
    accessor.renewArchiving.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRenewal = resolve;
        })
    );
    const lease = workspaceArchiveLeaseService.hold('ws', new Date(0));
    await vi.advanceTimersByTimeAsync(3 * ARCHIVE_LEASE_RENEW_MS);
    expect(accessor.renewArchiving).toHaveBeenCalledOnce();

    let released: Date | undefined;
    const release = lease.release().then((stamp) => {
      released = stamp;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBeUndefined();
    finishRenewal(true);
    await release;
    expect(released).toEqual(new Date(now.getTime() + ARCHIVE_LEASE_RENEW_MS));
  });

  it('keeps the last written stamp when a renewal fails or finds the row settled', async () => {
    accessor.renewArchiving
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValueOnce(false);
    const start = new Date(0);
    const lease = workspaceArchiveLeaseService.hold('ws', start);
    await vi.advanceTimersByTimeAsync(2 * ARCHIVE_LEASE_RENEW_MS);
    expect(accessor.renewArchiving).toHaveBeenCalledTimes(2);
    await expect(lease.release()).resolves.toBe(start);
  });
});
