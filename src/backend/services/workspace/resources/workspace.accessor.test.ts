import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();
const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockFindUniqueOrThrow = vi.fn();
const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateMany = vi.fn();
const mockExecuteRaw = vi.fn();
const mockTransaction = vi.fn();
const mockRatchetFindUnique = vi.fn();
const mockRatchetUpdateMany = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockFindUniqueOrThrow(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
    workspaceRatchet: {
      findUnique: (...args: unknown[]) => mockRatchetFindUnique(...args),
      updateMany: (...args: unknown[]) => mockRatchetUpdateMany(...args),
    },
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import { workspaceAccessor } from './workspace.accessor';

describe('workspaceAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks leaves queued mockResolvedValueOnce values in place, which
    // would spill from a test that queues more than it consumes into the next.
    mockUpdateMany.mockReset();
    mockRatchetUpdateMany.mockReset();
  });

  describe('create', () => {
    it('passes ratchetEnabled when provided', async () => {
      mockCreate.mockResolvedValue({ id: 'ws-1' });

      await workspaceAccessor.create({
        projectId: 'project-1',
        name: 'Issue workspace',
        githubIssueNumber: 12,
        ratchetEnabled: false,
      });

      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: 'project-1',
          name: 'Issue workspace',
          githubIssueNumber: 12,
          ratchet: { create: { enabled: false } },
        }),
        include: { ratchet: true },
      });
    });

    it('leaves the ratchet row on its column default when no preference is given', async () => {
      mockCreate.mockResolvedValue({ id: 'ws-2' });

      await workspaceAccessor.create({
        projectId: 'project-1',
        name: 'Manual workspace',
      });

      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: 'project-1',
          name: 'Manual workspace',
          ratchet: { create: { enabled: undefined } },
        }),
        include: { ratchet: true },
      });
    });

    it('always creates the ratchet row, so no workspace can exist without one', async () => {
      mockCreate.mockResolvedValue({ id: 'ws-3' });

      await workspaceAccessor.create({ projectId: 'project-1', name: 'Manual workspace' });

      const [{ data }] = mockCreate.mock.calls[0] as [{ data: { ratchet?: unknown } }];
      expect(data.ratchet).toBeDefined();
    });
  });

  it('excludes statuses in findByProjectIdWithSessions', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    await workspaceAccessor.findByProjectIdWithSessions('project-1', {
      excludeStatuses: ['ARCHIVING', 'ARCHIVED'],
    });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', status: { notIn: ['ARCHIVING', 'ARCHIVED'] } },
      orderBy: { updatedAt: 'desc' },
      include: { agentSessions: true, terminalSessions: true, ratchet: true },
    });
  });

  it('short-circuits findByIds and findByIdsWithProject for empty id arrays', async () => {
    await expect(workspaceAccessor.findByIds([])).resolves.toEqual([]);
    await expect(workspaceAccessor.findByIdsWithProject([])).resolves.toEqual([]);

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('queries IDs with and without project include', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'ws-1' }]).mockResolvedValueOnce([{ id: 'ws-2' }]);

    await workspaceAccessor.findByIds(['ws-1']);
    await workspaceAccessor.findByIdsWithProject(['ws-2']);

    expect(mockFindMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['ws-1'] } },
    });
    expect(mockFindMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['ws-2'] } },
      include: { project: true },
    });
  });

  describe('PR discovery scheduling', () => {
    it('finds a bounded due set with GitHub metadata and reset candidates first', async () => {
      const dueAt = new Date('2026-07-17T12:00:00.000Z');
      mockFindMany.mockResolvedValue([]);

      await workspaceAccessor.findNeedingPRDiscovery(25, dueAt);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          status: 'READY',
          prUrl: null,
          branchName: { not: null },
          project: {
            githubOwner: { not: null },
            githubRepo: { not: null },
          },
          OR: [{ prDiscoveryNextCheckAt: null }, { prDiscoveryNextCheckAt: { lte: dueAt } }],
        },
        include: { project: true },
        orderBy: [{ prDiscoveryNextCheckAt: 'asc' }, { updatedAt: 'desc' }],
        take: 25,
      });
    });

    it('uses the current time as the default due threshold', async () => {
      const now = new Date('2026-07-17T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      mockFindMany.mockResolvedValue([]);

      try {
        await workspaceAccessor.findNeedingPRDiscovery(10);
      } finally {
        vi.useRealTimers();
      }

      expect(mockFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ prDiscoveryNextCheckAt: null }, { prDiscoveryNextCheckAt: { lte: now } }],
          }),
        })
      );
    });

    it('claims an attempt only while all observed eligibility values still match', async () => {
      const expectedUpdatedAt = new Date('2026-07-17T11:59:00.000Z');
      const expectedNextCheckAt = new Date('2026-07-17T11:58:00.000Z');
      const checkedAt = new Date('2026-07-17T12:00:00.000Z');
      const nextCheckAt = new Date('2026-07-17T12:06:00.000Z');
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.claimPRDiscoveryAttempt('ws-1', {
          branchName: 'feature/pr-discovery',
          expectedUpdatedAt,
          expectedRetryCount: 1,
          expectedNextCheckAt,
          checkedAt,
          nextCheckAt,
        })
      ).resolves.toBe(true);

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'ws-1',
          status: 'READY',
          prUrl: null,
          branchName: 'feature/pr-discovery',
          updatedAt: expectedUpdatedAt,
          prDiscoveryRetryCount: 1,
          prDiscoveryNextCheckAt: expectedNextCheckAt,
        },
        data: {
          prDiscoveryLastCheckedAt: checkedAt,
          prDiscoveryRetryCount: { increment: 1 },
          prDiscoveryNextCheckAt: nextCheckAt,
        },
      });
    });

    it('guards a claim whose observed next-check timestamp was null', async () => {
      const expectedUpdatedAt = new Date('2026-07-17T11:59:00.000Z');
      const checkedAt = new Date('2026-07-17T12:00:00.000Z');
      const nextCheckAt = new Date('2026-07-17T12:03:00.000Z');
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAccessor.claimPRDiscoveryAttempt('ws-1', {
          branchName: 'feature/pr-discovery',
          expectedUpdatedAt,
          expectedRetryCount: 0,
          expectedNextCheckAt: null,
          checkedAt,
          nextCheckAt,
        })
      ).resolves.toBe(false);

      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ prDiscoveryNextCheckAt: null }),
        })
      );
    });

    it('attaches a discovered PR only while the exact discovery claim remains current', async () => {
      const checkedAt = new Date('2026-07-17T12:00:00.000Z');
      const nextCheckAt = new Date('2026-07-17T12:06:00.000Z');
      const prUpdatedAt = new Date('2026-07-17T12:01:00.000Z');
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.attachDiscoveredPRIfClaimMatches(
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

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'ws-1',
          status: 'READY',
          prUrl: null,
          branchName: 'feature/pr-discovery',
          prDiscoveryLastCheckedAt: checkedAt,
          prDiscoveryRetryCount: 2,
          prDiscoveryNextCheckAt: nextCheckAt,
        },
        data: {
          prUrl: 'https://github.com/org/repo/pull/12',
          prUpdatedAt,
        },
      });
    });

    it('updates a discovered PR snapshot only while its URL remains attached', async () => {
      const prUpdatedAt = new Date('2026-07-17T12:02:00.000Z');
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.updatePRSnapshotIfUrlMatches(
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

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'ws-1',
          prUrl: 'https://github.com/org/repo/pull/12',
        },
        data: {
          prNumber: 12,
          prState: 'OPEN',
          prReviewState: 'APPROVED',
          prCiStatus: 'SUCCESS',
          prUpdatedAt,
        },
      });
    });

    it('resets discovery backoff only while the workspace remains eligible', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await expect(workspaceAccessor.resetPRDiscoveryBackoff('ws-1')).resolves.toBe(true);

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 'ws-1',
          status: 'READY',
          prUrl: null,
          branchName: { not: null },
        },
        data: {
          prDiscoveryLastCheckedAt: null,
          prDiscoveryRetryCount: 0,
          prDiscoveryNextCheckAt: null,
        },
      });
    });
  });

  it('marks workspace as having had sessions with guarded updateMany', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await workspaceAccessor.markHasHadSessions('ws-1');

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', hasHadSessions: false },
      data: { hasHadSessions: true },
    });
  });

  describe('PR aggregate writes with dispatch reset', () => {
    /**
     * The aggregate lives on Workspace and the dispatch on WorkspaceRatchet, so
     * the two writes are separate statements in one transaction. Each is
     * guarded by the state it was decided from, and the aggregate goes first.
     */
    function currentAggregate(overrides: Record<string, unknown> = {}) {
      return {
        prUrl: null,
        prNumber: 41,
        prState: 'CHANGES_REQUESTED',
        prCiStatus: 'FAILURE',
        prReviewState: 'CHANGES_REQUESTED',
        prUpdatedAt: new Date('2026-07-17T11:59:00.000Z'),
        ...overrides,
      };
    }

    function currentDispatch(overrides: Record<string, unknown> = {}) {
      return {
        activeSessionId: null,
        dispatchSnapshotKey: 'failed:41',
        dispatchOutcome: 'DIED',
        dispatchRetryCount: 3,
        ...overrides,
      };
    }

    function runInTransaction() {
      mockTransaction.mockImplementation(async (callback) =>
        callback({
          workspace: {
            findUniqueOrThrow: mockFindUnique,
            update: mockUpdate,
            updateMany: mockUpdateMany,
          },
          workspaceRatchet: {
            findUnique: mockRatchetFindUnique,
            updateMany: mockRatchetUpdateMany,
          },
        })
      );
    }

    const prUpdatedAt = new Date('2026-07-17T12:00:00.000Z');
    const changedObservation = {
      prNumber: 42,
      prState: 'OPEN' as const,
      prCiStatus: 'PENDING' as const,
      prReviewState: 'CHANGES_REQUESTED',
      prUpdatedAt,
    };

    beforeEach(() => {
      mockFindUnique.mockResolvedValue(currentAggregate());
      mockRatchetFindUnique.mockResolvedValue(currentDispatch());
      runInTransaction();
    });

    it('writes the changed aggregate guarded on the aggregate alone', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: true });

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ws-1', ...currentAggregate() },
        data: {
          prNumber: 42,
          prState: 'OPEN',
          prCiStatus: 'PENDING',
          prReviewState: 'CHANGES_REQUESTED',
          prUpdatedAt,
        },
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('resets the settled dispatch guarded on every field it was read with', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...currentDispatch() },
        data: { dispatchOutcome: null, dispatchRetryCount: 0 },
      });
    });

    it('keeps the aggregate write when a newer dispatch wins the reset guard', async () => {
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: false });

      expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('skips the dispatch reset entirely when the aggregate write loses its guard', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('leaves a RUNNING dispatch alone even when the aggregate changed', async () => {
      mockRatchetFindUnique.mockResolvedValue(currentDispatch({ dispatchOutcome: 'RUNNING' }));
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: false });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('leaves settled dispatch metadata alone for an identical aggregate', async () => {
      mockFindUnique.mockResolvedValue(
        currentAggregate({ prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 })
      );
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', {
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
        prState: 'CHANGES_REQUESTED',
        prCiStatus: 'FAILURE',
        prReviewState: 'CHANGES_REQUESTED',
        prUpdatedAt,
      });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('resets settled metadata for a changed direct CI observation', async () => {
      mockFindUnique.mockResolvedValue(
        currentAggregate({ prUrl: 'https://github.com/org/repo/pull/42', prNumber: 42 })
      );
      mockUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyCIObservationWithDispatchReset('ws-1', {
          prCiStatus: 'PENDING',
          prUpdatedAt,
        })
      ).resolves.toEqual({ applied: true, dispatchReset: true });

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...currentDispatch() },
        data: { dispatchOutcome: null, dispatchRetryCount: 0 },
      });
    });

    it('does not reset when the workspace has no ratchet row at all', async () => {
      mockRatchetFindUnique.mockResolvedValue(null);
      mockUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: false });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });
  });

  it('finishes auto-iteration only when the session pointer still matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspaceAccessor.finishAutoIterationIfSessionMatches('ws-1', 'session-1', 'STOPPED')
    ).resolves.toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', autoIterationSessionId: 'session-1' },
      data: {
        autoIterationStatus: 'STOPPED',
        autoIterationSessionId: null,
      },
    });
  });

  it('clears auto-iteration session only when the expected pointer still matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      workspaceAccessor.clearAutoIterationSessionIfMatches('ws-1', 'session-1')
    ).resolves.toBe(false);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', autoIterationSessionId: 'session-1' },
      data: { autoIterationSessionId: null },
    });
  });

  it('selects only the auto-iteration execution context', async () => {
    mockFindUnique.mockResolvedValue({
      worktreePath: '/tmp/worktree',
      autoIterationSessionId: 'session-1',
    });

    await expect(workspaceAccessor.findAutoIterationExecutionContext('ws-1')).resolves.toEqual({
      worktreePath: '/tmp/worktree',
      autoIterationSessionId: 'session-1',
    });

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { worktreePath: true, autoIterationSessionId: true },
    });
  });

  it('selects only run-script execution state', async () => {
    const state = {
      runScriptStatus: 'RUNNING',
      runScriptPid: 123,
      runScriptPort: 3000,
      runScriptStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    mockFindUnique.mockResolvedValue(state);

    await expect(workspaceAccessor.findRunScriptExecutionState('ws-1')).resolves.toEqual(state);

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: {
        runScriptStatus: true,
        runScriptPid: true,
        runScriptPort: true,
        runScriptStartedAt: true,
      },
    });
  });

  it('selects only run-script execution state when requiring a result', async () => {
    const state = {
      runScriptStatus: 'RUNNING',
      runScriptPid: 123,
      runScriptPort: 3000,
      runScriptStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    mockFindUniqueOrThrow.mockResolvedValue(state);

    await expect(workspaceAccessor.findRunScriptExecutionStateOrThrow('ws-1')).resolves.toEqual(
      state
    );

    expect(mockFindUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: {
        runScriptStatus: true,
        runScriptPid: true,
        runScriptPort: true,
        runScriptStartedAt: true,
      },
    });
  });

  it('appends init output and skips existence check when update succeeds', async () => {
    mockExecuteRaw.mockResolvedValue(1);

    await workspaceAccessor.appendInitOutput('ws-1', 'hello output', 256);

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('checks existence when init output update affects no rows and throws if missing', async () => {
    mockExecuteRaw.mockResolvedValue(0);
    mockFindUnique.mockResolvedValue(null);

    await expect(workspaceAccessor.appendInitOutput('missing', 'line')).rejects.toThrow(
      'Workspace not found: missing'
    );
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'missing' },
      select: { id: true },
    });
  });

  it('returns successfully when init output update affects no rows but workspace exists', async () => {
    mockExecuteRaw.mockResolvedValue(0);
    mockFindUnique.mockResolvedValue({ id: 'ws-1' });

    await expect(workspaceAccessor.appendInitOutput('ws-1', 'line')).resolves.toBeUndefined();
  });

  describe('resetStaleRunScriptStatuses', () => {
    it('returns empty array and skips update when no stale workspaces exist', async () => {
      mockFindMany.mockResolvedValue([]);

      const result = await workspaceAccessor.resetStaleRunScriptStatuses();

      expect(result).toEqual([]);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('resets STARTING and STOPPING workspaces to IDLE and returns affected records', async () => {
      const stale = [
        { id: 'ws-1', runScriptStatus: 'STARTING' },
        { id: 'ws-2', runScriptStatus: 'STOPPING' },
      ];
      mockFindMany.mockResolvedValue(stale);
      mockUpdateMany.mockResolvedValue({ count: 2 });

      const result = await workspaceAccessor.resetStaleRunScriptStatuses();

      expect(result).toEqual(stale);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { runScriptStatus: { in: ['STARTING', 'STOPPING'] } },
        select: { id: true, runScriptStatus: true },
      });
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['ws-1', 'ws-2'] },
          runScriptStatus: { in: ['STARTING', 'STOPPING'] },
        },
        data: {
          runScriptStatus: 'IDLE',
          runScriptPid: null,
          runScriptPort: null,
          runScriptStartedAt: null,
        },
      });
    });
  });

  describe('findStaleArchivingWithProject', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('queries ARCHIVING workspaces older than the stale threshold with project data', async () => {
      const now = new Date('2024-01-15T12:00:00Z');
      vi.setSystemTime(now);
      const staleWorkspace = {
        id: 'ws-archiving',
        status: 'ARCHIVING',
        updatedAt: new Date('2024-01-15T11:40:00Z'),
        project: { id: 'proj-1' },
      };
      mockFindMany.mockResolvedValue([staleWorkspace]);

      const result = await workspaceAccessor.findStaleArchivingWithProject();

      expect(result).toEqual([staleWorkspace]);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          status: 'ARCHIVING',
          updatedAt: { lt: expect.any(Date) },
        },
        include: { project: true },
        orderBy: { updatedAt: 'asc' },
      });

      const callArgs = mockFindMany.mock.calls[0]![0];
      expect(callArgs.where.updatedAt.lt.getTime()).toBe(now.getTime() - 10 * 60 * 1000);
    });

    it('returns an empty array when no stale ARCHIVING workspaces exist', async () => {
      mockFindMany.mockResolvedValue([]);

      const result = await workspaceAccessor.findStaleArchivingWithProject();

      expect(result).toEqual([]);
    });
  });
});
