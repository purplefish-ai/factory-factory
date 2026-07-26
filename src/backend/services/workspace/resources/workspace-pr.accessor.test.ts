import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkspaceFindMany = vi.fn();
const mockPrUpdateMany = vi.fn();
const mockPrFindUnique = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findMany: (...args: unknown[]) => mockWorkspaceFindMany(...args),
    },
    workspacePR: {
      updateMany: (...args: unknown[]) => mockPrUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockPrFindUnique(...args),
    },
  },
}));

import {
  flattenWorkspacePR,
  WORKSPACE_PR_DEFAULTS,
  workspacePrAccessor,
} from './workspace-pr.accessor';

/** A persisted row with every column populated, for flatten round-trips. */
const fullRow = {
  workspaceId: 'ws-1',
  url: 'https://github.com/org/repo/pull/12',
  number: 12,
  state: 'OPEN' as const,
  reviewState: 'APPROVED',
  ciStatus: 'SUCCESS' as const,
  syncedAt: new Date('2026-07-26T12:00:00.000Z'),
  discoveryLastCheckedAt: new Date('2026-07-26T11:00:00.000Z'),
  discoveryRetryCount: 2,
  discoveryNextCheckAt: new Date('2026-07-26T13:00:00.000Z'),
  ciFailedAt: new Date('2026-07-26T10:00:00.000Z'),
  ciLastNotifiedAt: new Date('2026-07-26T10:30:00.000Z'),
  reviewLastCheckedAt: new Date('2026-07-26T09:00:00.000Z'),
  reviewLastCommentId: 'comment-7',
};

describe('flattenWorkspacePR', () => {
  it('maps every column onto its caller-facing pr* name', () => {
    expect(flattenWorkspacePR(fullRow)).toEqual({
      prUrl: 'https://github.com/org/repo/pull/12',
      prNumber: 12,
      prState: 'OPEN',
      prReviewState: 'APPROVED',
      prCiStatus: 'SUCCESS',
      prUpdatedAt: new Date('2026-07-26T12:00:00.000Z'),
      prDiscoveryLastCheckedAt: new Date('2026-07-26T11:00:00.000Z'),
      prDiscoveryRetryCount: 2,
      prDiscoveryNextCheckAt: new Date('2026-07-26T13:00:00.000Z'),
      prCiFailedAt: new Date('2026-07-26T10:00:00.000Z'),
      prCiLastNotifiedAt: new Date('2026-07-26T10:30:00.000Z'),
      prReviewLastCheckedAt: new Date('2026-07-26T09:00:00.000Z'),
      prReviewLastCommentId: 'comment-7',
    });
  });

  it('maps syncedAt to the prUpdatedAt name callers and the export format use', () => {
    expect(flattenWorkspacePR(fullRow).prUpdatedAt).toEqual(fullRow.syncedAt);
  });

  it('substitutes column defaults for a missing row', () => {
    expect(flattenWorkspacePR(null)).toEqual(WORKSPACE_PR_DEFAULTS);
    expect(flattenWorkspacePR(undefined)).toEqual(WORKSPACE_PR_DEFAULTS);
  });

  it('returns a fresh defaults object each time, so callers cannot mutate it', () => {
    const first = flattenWorkspacePR(null);
    first.prNumber = 99;
    expect(flattenWorkspacePR(null).prNumber).toBeNull();
    expect(WORKSPACE_PR_DEFAULTS.prNumber).toBeNull();
  });
});

describe('workspacePrAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrUpdateMany.mockReset();
  });

  describe('candidate queries', () => {
    it('finds stale-sync candidates by relation filter, oldest sync first', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
      mockWorkspaceFindMany.mockResolvedValue([]);

      try {
        await workspacePrAccessor.findNeedingSync(5);
      } finally {
        vi.useRealTimers();
      }

      expect(mockWorkspaceFindMany).toHaveBeenCalledWith({
        where: {
          status: 'READY',
          pr: {
            url: { not: null },
            OR: [{ syncedAt: null }, { syncedAt: { lt: new Date('2026-07-26T11:55:00.000Z') } }],
          },
        },
        include: { project: true, pr: true },
        orderBy: { pr: { syncedAt: 'asc' } },
      });
    });

    it('finds a bounded due set with GitHub metadata and reset candidates first', async () => {
      const dueAt = new Date('2026-07-17T12:00:00.000Z');
      mockWorkspaceFindMany.mockResolvedValue([]);

      await workspacePrAccessor.findNeedingDiscovery(25, dueAt);

      expect(mockWorkspaceFindMany).toHaveBeenCalledWith({
        where: {
          status: 'READY',
          branchName: { not: null },
          project: {
            githubOwner: { not: null },
            githubRepo: { not: null },
          },
          pr: {
            url: null,
            OR: [{ discoveryNextCheckAt: null }, { discoveryNextCheckAt: { lte: dueAt } }],
          },
        },
        include: { project: true, pr: true },
        orderBy: [{ pr: { discoveryNextCheckAt: 'asc' } }, { updatedAt: 'desc' }],
        take: 25,
      });
    });

    it('uses the current time as the default due threshold', async () => {
      const now = new Date('2026-07-17T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      mockWorkspaceFindMany.mockResolvedValue([]);

      try {
        await workspacePrAccessor.findNeedingDiscovery(10);
      } finally {
        vi.useRealTimers();
      }

      expect(mockWorkspaceFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            pr: expect.objectContaining({
              OR: [{ discoveryNextCheckAt: null }, { discoveryNextCheckAt: { lte: now } }],
            }),
          }),
        })
      );
    });

    it('flattens the joined PR row onto each returned candidate', async () => {
      mockWorkspaceFindMany.mockResolvedValue([
        { id: 'ws-1', project: { id: 'p-1' }, pr: fullRow },
      ]);

      const [candidate] = await workspacePrAccessor.findNeedingSync();

      expect(candidate).toMatchObject({
        id: 'ws-1',
        project: { id: 'p-1' },
        prUrl: 'https://github.com/org/repo/pull/12',
        prNumber: 12,
      });
      expect(candidate).not.toHaveProperty('pr');
    });
  });

  describe('claimDiscoveryAttempt', () => {
    it('guards workspace columns by relation filter and its own by column', async () => {
      const expectedUpdatedAt = new Date('2026-07-17T11:59:00.000Z');
      const expectedNextCheckAt = new Date('2026-07-17T11:58:00.000Z');
      const checkedAt = new Date('2026-07-17T12:00:00.000Z');
      const nextCheckAt = new Date('2026-07-17T12:06:00.000Z');
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspacePrAccessor.claimDiscoveryAttempt('ws-1', {
          branchName: 'feature/pr-discovery',
          expectedUpdatedAt,
          expectedRetryCount: 1,
          expectedNextCheckAt,
          checkedAt,
          nextCheckAt,
        })
      ).resolves.toBe(true);

      expect(mockPrUpdateMany).toHaveBeenCalledWith({
        where: {
          workspaceId: 'ws-1',
          url: null,
          discoveryRetryCount: 1,
          discoveryNextCheckAt: expectedNextCheckAt,
          workspace: {
            status: 'READY',
            branchName: 'feature/pr-discovery',
            updatedAt: expectedUpdatedAt,
          },
        },
        data: {
          discoveryLastCheckedAt: checkedAt,
          discoveryRetryCount: { increment: 1 },
          discoveryNextCheckAt: nextCheckAt,
        },
      });
    });

    it('guards a claim whose observed next-check timestamp was null', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspacePrAccessor.claimDiscoveryAttempt('ws-1', {
          branchName: 'feature/pr-discovery',
          expectedUpdatedAt: new Date('2026-07-17T11:59:00.000Z'),
          expectedRetryCount: 0,
          expectedNextCheckAt: null,
          checkedAt: new Date('2026-07-17T12:00:00.000Z'),
          nextCheckAt: new Date('2026-07-17T12:03:00.000Z'),
        })
      ).resolves.toBe(false);

      expect(mockPrUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ discoveryNextCheckAt: null }),
        })
      );
    });

    it('does not write the workspace row, so a poll is not workspace activity', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

      await workspacePrAccessor.claimDiscoveryAttempt('ws-1', {
        branchName: 'feature/pr-discovery',
        expectedUpdatedAt: new Date('2026-07-17T11:59:00.000Z'),
        expectedRetryCount: 0,
        expectedNextCheckAt: null,
        checkedAt: new Date('2026-07-17T12:00:00.000Z'),
        nextCheckAt: new Date('2026-07-17T12:03:00.000Z'),
      });

      expect(mockPrUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            discoveryLastCheckedAt: new Date('2026-07-17T12:00:00.000Z'),
            discoveryRetryCount: { increment: 1 },
            discoveryNextCheckAt: new Date('2026-07-17T12:03:00.000Z'),
          },
        })
      );
    });
  });

  it('attaches a discovered PR only while the exact discovery claim remains current', async () => {
    const checkedAt = new Date('2026-07-17T12:00:00.000Z');
    const nextCheckAt = new Date('2026-07-17T12:06:00.000Z');
    const prUpdatedAt = new Date('2026-07-17T12:01:00.000Z');
    mockPrUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspacePrAccessor.attachDiscoveredPRIfClaimMatches(
        'ws-1',
        'https://github.com/org/repo/pull/12',
        {
          branchName: 'feature/pr-discovery',
          checkedAt,
          retryCount: 2,
          nextCheckAt,
        },
        prUpdatedAt
      )
    ).resolves.toBe(true);

    expect(mockPrUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        url: null,
        discoveryLastCheckedAt: checkedAt,
        discoveryRetryCount: 2,
        discoveryNextCheckAt: nextCheckAt,
        workspace: { status: 'READY', branchName: 'feature/pr-discovery' },
      },
      data: { url: 'https://github.com/org/repo/pull/12', syncedAt: prUpdatedAt },
    });
  });

  it('updates a discovered PR snapshot only while its URL remains attached', async () => {
    const prUpdatedAt = new Date('2026-07-17T12:02:00.000Z');
    mockPrUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspacePrAccessor.updateSnapshotIfUrlMatches(
        'ws-1',
        'https://github.com/org/repo/pull/12',
        {
          prNumber: 12,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
        },
        prUpdatedAt
      )
    ).resolves.toBe(true);

    expect(mockPrUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', url: 'https://github.com/org/repo/pull/12' },
      data: {
        number: 12,
        state: 'OPEN',
        reviewState: 'APPROVED',
        ciStatus: 'SUCCESS',
        syncedAt: prUpdatedAt,
      },
    });
  });

  it('resets discovery backoff only while the workspace remains eligible', async () => {
    mockPrUpdateMany.mockResolvedValue({ count: 1 });

    await expect(workspacePrAccessor.resetDiscoveryBackoff('ws-1')).resolves.toBe(true);

    expect(mockPrUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        url: null,
        workspace: { status: 'READY', branchName: { not: null } },
      },
      data: {
        discoveryLastCheckedAt: null,
        discoveryRetryCount: 0,
        discoveryNextCheckAt: null,
      },
    });
  });

  describe('write', () => {
    it('translates supplied pr* names to columns and omits absent ones', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

      await workspacePrAccessor.write('ws-1', {
        prState: 'MERGED',
        prCiLastNotifiedAt: null,
      });

      expect(mockPrUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { state: 'MERGED', ciLastNotifiedAt: null },
      });
    });

    it('writes an explicit null but skips an undefined field', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

      await workspacePrAccessor.write('ws-1', {
        prReviewState: null,
        prReviewLastCommentId: undefined,
      });

      expect(mockPrUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { reviewState: null },
      });
    });

    it('does not issue a query when nothing was supplied', async () => {
      await workspacePrAccessor.write('ws-1', {});

      expect(mockPrUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('aggregate compare-and-swap', () => {
    const transaction = {
      workspacePR: {
        findUnique: (...args: unknown[]) => mockPrFindUnique(...args),
        updateMany: (...args: unknown[]) => mockPrUpdateMany(...args),
      },
    } as unknown as Parameters<typeof workspacePrAccessor.readAggregate>[0];

    it('reads the aggregate under its caller-facing names', async () => {
      mockPrFindUnique.mockResolvedValue({
        url: 'https://github.com/org/repo/pull/12',
        number: 12,
        state: 'OPEN',
        reviewState: null,
        ciStatus: 'PENDING',
        syncedAt: new Date('2026-07-26T12:00:00.000Z'),
      });

      await expect(workspacePrAccessor.readAggregate(transaction, 'ws-1')).resolves.toEqual({
        prUrl: 'https://github.com/org/repo/pull/12',
        prNumber: 12,
        prState: 'OPEN',
        prReviewState: null,
        prCiStatus: 'PENDING',
        prUpdatedAt: new Date('2026-07-26T12:00:00.000Z'),
      });
    });

    it('reports a missing row rather than inventing defaults to guard on', async () => {
      mockPrFindUnique.mockResolvedValue(null);

      await expect(workspacePrAccessor.readAggregate(transaction, 'ws-1')).resolves.toBeNull();
    });

    it('guards every aggregate column against the value that was read', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      const guard = {
        prUrl: 'https://github.com/org/repo/pull/12',
        prNumber: 12,
        prState: 'OPEN' as const,
        prReviewState: null,
        prCiStatus: 'PENDING' as const,
        prUpdatedAt: new Date('2026-07-26T12:00:00.000Z'),
      };

      await expect(
        workspacePrAccessor.applyAggregateIfUnchanged(transaction, 'ws-1', guard, {
          prCiStatus: 'SUCCESS',
          prUpdatedAt: new Date('2026-07-26T12:05:00.000Z'),
        })
      ).resolves.toBe(true);

      expect(mockPrUpdateMany).toHaveBeenCalledWith({
        where: {
          workspaceId: 'ws-1',
          url: 'https://github.com/org/repo/pull/12',
          number: 12,
          state: 'OPEN',
          reviewState: null,
          ciStatus: 'PENDING',
          syncedAt: new Date('2026-07-26T12:00:00.000Z'),
        },
        data: { ciStatus: 'SUCCESS', syncedAt: new Date('2026-07-26T12:05:00.000Z') },
      });
    });

    it('reports a lost race when the guard matched nothing', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspacePrAccessor.applyAggregateIfUnchanged(
          transaction,
          'ws-1',
          {
            prUrl: null,
            prNumber: null,
            prState: 'NONE',
            prReviewState: null,
            prCiStatus: 'UNKNOWN',
            prUpdatedAt: null,
          },
          { prCiStatus: 'SUCCESS' }
        )
      ).resolves.toBe(false);
    });
  });

  it('clears the discovery schedule in the caller transaction', async () => {
    mockPrUpdateMany.mockResolvedValue({ count: 1 });
    const transaction = {
      workspacePR: { updateMany: (...args: unknown[]) => mockPrUpdateMany(...args) },
    } as unknown as Parameters<typeof workspacePrAccessor.clearDiscoverySchedule>[0];

    await workspacePrAccessor.clearDiscoverySchedule(transaction, 'ws-1');

    expect(mockPrUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1' },
      data: {
        discoveryLastCheckedAt: null,
        discoveryRetryCount: 0,
        discoveryNextCheckAt: null,
      },
    });
  });
});
