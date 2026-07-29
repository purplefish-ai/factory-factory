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
const mockPrFindUnique = vi.fn();
const mockPrUpdateMany = vi.fn();
const mockRunScriptUpdateMany = vi.fn();
const mockAutoIterationFindMany = vi.fn();
const mockAutoIterationUpdateMany = vi.fn();

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
    workspacePR: {
      findUnique: (...args: unknown[]) => mockPrFindUnique(...args),
      updateMany: (...args: unknown[]) => mockPrUpdateMany(...args),
    },
    workspaceRunScript: {
      updateMany: (...args: unknown[]) => mockRunScriptUpdateMany(...args),
    },
    workspaceAutoIteration: {
      findMany: (...args: unknown[]) => mockAutoIterationFindMany(...args),
      updateMany: (...args: unknown[]) => mockAutoIterationUpdateMany(...args),
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
    mockPrUpdateMany.mockReset();
    mockRunScriptUpdateMany.mockReset();
    mockAutoIterationUpdateMany.mockReset();
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
          pr: { create: {} },
          runScript: { create: {} },
          autoIteration: { create: { mode: undefined, config: undefined } },
        }),
        include: { ratchet: true, pr: true, runScript: true, autoIteration: true },
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
          pr: { create: {} },
          runScript: { create: {} },
          autoIteration: { create: { mode: undefined, config: undefined } },
        }),
        include: { ratchet: true, pr: true, runScript: true, autoIteration: true },
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
      include: {
        agentSessions: true,
        terminalSessions: true,
        ratchet: true,
        pr: true,
        runScript: true,
        autoIteration: true,
      },
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
      include: { project: true, pr: true, autoIteration: true },
    });
  });

  describe('ratchetState projection at the flatten boundary', () => {
    function row(
      pr: Record<string, unknown>,
      ratchet: Record<string, unknown> = { enabled: true }
    ) {
      return { id: 'ws-1', ratchet, pr };
    }

    it('derives the state from the joined PR row instead of reading a column', async () => {
      mockFindUnique.mockResolvedValue(
        row({ state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: false, reviewState: null })
      );

      await expect(workspaceAccessor.findById('ws-1')).resolves.toMatchObject({
        ratchetState: 'CI_FAILED',
      });
    });

    it('joins both side tables on the read that projects the state', async () => {
      mockFindUnique.mockResolvedValue(row({ state: 'OPEN', ciStatus: 'SUCCESS' }));

      await workspaceAccessor.findById('ws-1');

      expect(mockFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            ratchet: true,
            pr: true,
            runScript: true,
            autoIteration: true,
          }),
        })
      );
    });

    it('projects IDLE for a disabled workspace whatever the PR says', async () => {
      // The old settling write left a window where a disabled workspace still
      // read as its last progression state. The projection closes it: the two
      // cannot disagree because one is computed from the other.
      mockFindUnique.mockResolvedValue(
        row(
          { state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: true, reviewState: null },
          { enabled: false }
        )
      );

      await expect(workspaceAccessor.findById('ws-1')).resolves.toMatchObject({
        ratchetEnabled: false,
        ratchetState: 'IDLE',
      });
    });

    it('surfaces a merge conflict that only the conflict column records', async () => {
      mockFindUnique.mockResolvedValue(
        row({ state: 'OPEN', ciStatus: 'SUCCESS', hasMergeConflict: true, reviewState: null })
      );

      await expect(workspaceAccessor.findById('ws-1')).resolves.toMatchObject({
        prHasMergeConflict: true,
        ratchetState: 'MERGE_CONFLICT',
      });
    });

    it('falls back to the side-table defaults when a row is missing', async () => {
      mockFindUnique.mockResolvedValue({ id: 'ws-1', ratchet: null, pr: null });

      await expect(workspaceAccessor.findById('ws-1')).resolves.toMatchObject({
        // Defaults are enabled + no PR, which derives to IDLE.
        ratchetEnabled: true,
        prState: 'NONE',
        ratchetState: 'IDLE',
      });
    });

    it('drops the relation objects so callers see only the flat shape', async () => {
      mockFindUnique.mockResolvedValue(row({ state: 'OPEN', ciStatus: 'PENDING' }));

      const workspace = await workspaceAccessor.findById('ws-1');

      expect(workspace).not.toHaveProperty('ratchet');
      expect(workspace).not.toHaveProperty('pr');
      expect(workspace).toMatchObject({ ratchetState: 'CI_RUNNING' });
    });
  });

  describe('PR aggregate writes with dispatch reset', () => {
    /**
     * The aggregate lives on WorkspacePR and the dispatch on WorkspaceRatchet, so
     * the two writes are separate statements in one transaction. Each is guarded
     * by the state it was decided from, and the aggregate goes first.
     */
    function currentColumns(overrides: Record<string, unknown> = {}) {
      return {
        url: null,
        number: 41,
        state: 'CHANGES_REQUESTED',
        ciStatus: 'FAILURE',
        reviewState: 'CHANGES_REQUESTED',
        syncedAt: new Date('2026-07-17T11:59:00.000Z'),
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
          workspacePR: {
            findUnique: mockPrFindUnique,
            updateMany: mockPrUpdateMany,
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
      mockPrFindUnique.mockResolvedValue(currentColumns());
      mockRatchetFindUnique.mockResolvedValue(currentDispatch());
      runInTransaction();
    });

    it('writes the changed aggregate guarded on the aggregate alone', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: true });

      expect(mockPrUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...currentColumns() },
        data: {
          number: 42,
          state: 'OPEN',
          ciStatus: 'PENDING',
          reviewState: 'CHANGES_REQUESTED',
          syncedAt: prUpdatedAt,
        },
      });
    });

    it('leaves the workspace row alone when no branch correction came with it', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation);

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('writes a corrected branch name only after the aggregate write holds', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', {
        ...changedObservation,
        branchName: 'feature/actual-head',
      });

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { branchName: 'feature/actual-head' },
      });
    });

    it('does not write the branch name when the aggregate write lost its guard', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', {
          ...changedObservation,
          branchName: 'feature/actual-head',
        })
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('resets the settled dispatch guarded on every field it was read with', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...currentDispatch() },
        data: { dispatchOutcome: null, dispatchRetryCount: 0, dispatchStalled: false },
      });
    });

    it('keeps the aggregate write when a newer dispatch wins the reset guard', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: false });

      expect(mockPrUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('skips the dispatch reset entirely when the aggregate write loses its guard', async () => {
      mockPrUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('leaves a RUNNING dispatch alone even when the aggregate changed', async () => {
      mockRatchetFindUnique.mockResolvedValue(currentDispatch({ dispatchOutcome: 'RUNNING' }));
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: false });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('leaves settled dispatch metadata alone for an identical aggregate', async () => {
      mockPrFindUnique.mockResolvedValue(
        currentColumns({ url: 'https://github.com/org/repo/pull/42', number: 42 })
      );
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

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

    it('refuses an observation whose PR is no longer the one attached', async () => {
      // The workspace was re-pointed at a new PR while the check was off fetching
      // the old one. The aggregate compare-and-swap cannot see this: it reads its
      // guard inside the write transaction, so it catches a racing write, not a
      // stale observation. Without the guard a check that saw MERGED on the old PR
      // would stamp it onto the new one -- and a workspace deriving MERGED leaves
      // the ratchet poll set entirely.
      mockPrFindUnique.mockResolvedValue(
        currentColumns({ url: 'https://github.com/org/repo/pull/99', number: 99 })
      );

      await expect(
        workspaceAccessor.applyPrObservationWithDispatchReset('ws-1', {
          expectedPrUrl: 'https://github.com/org/repo/pull/42',
          expectedPrNumber: 42,
          prCiStatus: 'SUCCESS',
          prState: 'MERGED',
          prReviewState: null,
          prHasMergeConflict: false,
          prUpdatedAt,
        })
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockPrUpdateMany).not.toHaveBeenCalled();
      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses a stale observation after the PR URL changes while its number is unknown', async () => {
      mockPrFindUnique.mockResolvedValue(
        currentColumns({ url: 'https://github.com/org/repo/pull/99', number: null })
      );

      await expect(
        workspaceAccessor.applyPrObservationWithDispatchReset('ws-1', {
          expectedPrUrl: 'https://github.com/org/repo/pull/42',
          expectedPrNumber: 42,
          prCiStatus: 'SUCCESS',
          prState: 'MERGED',
          prReviewState: null,
          prHasMergeConflict: false,
          prUpdatedAt,
        })
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockPrUpdateMany).not.toHaveBeenCalled();
      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses a stale observation when a failed re-point leaves the old PR number cached', async () => {
      mockPrFindUnique.mockResolvedValue(
        currentColumns({ url: 'https://github.com/org/repo/pull/99', number: 42 })
      );

      await expect(
        workspaceAccessor.applyPrObservationWithDispatchReset('ws-1', {
          expectedPrUrl: 'https://github.com/org/repo/pull/42',
          expectedPrNumber: 42,
          prCiStatus: 'SUCCESS',
          prState: 'MERGED',
          prReviewState: null,
          prHasMergeConflict: false,
          prUpdatedAt,
        })
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockPrUpdateMany).not.toHaveBeenCalled();
      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('accepts an observation when the cached PR number is not yet known', async () => {
      // Discovery attaches a url without a number, and the check's own number came
      // from parsing that url, so a null is "not known yet" rather than a different
      // PR. Rejecting it would block the first observation of a discovered PR.
      mockPrFindUnique.mockResolvedValue(
        currentColumns({ url: 'https://github.com/org/repo/pull/42', number: null })
      );
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrObservationWithDispatchReset('ws-1', {
          expectedPrUrl: 'https://github.com/org/repo/pull/42',
          expectedPrNumber: 42,
          prCiStatus: 'SUCCESS',
          prState: 'OPEN',
          prReviewState: null,
          prHasMergeConflict: false,
          prUpdatedAt,
        })
      ).resolves.toMatchObject({ applied: true });
    });

    it('resets settled metadata for a changed direct CI observation', async () => {
      mockPrFindUnique.mockResolvedValue(
        currentColumns({ url: 'https://github.com/org/repo/pull/42', number: 42 })
      );
      mockPrUpdateMany.mockResolvedValue({ count: 1 });
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrObservationWithDispatchReset('ws-1', {
          expectedPrUrl: 'https://github.com/org/repo/pull/42',
          expectedPrNumber: 42,
          prCiStatus: 'PENDING',
          prState: 'OPEN',
          prReviewState: null,
          prHasMergeConflict: false,
          prUpdatedAt,
        })
      ).resolves.toEqual({ applied: true, dispatchReset: true });

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...currentDispatch() },
        data: { dispatchOutcome: null, dispatchRetryCount: 0, dispatchStalled: false },
      });
    });

    it('does not reset when the workspace has no ratchet row at all', async () => {
      mockRatchetFindUnique.mockResolvedValue(null);
      mockPrUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: true, dispatchReset: false });

      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });

    it('reports no write at all when the workspace has no PR row', async () => {
      mockPrFindUnique.mockResolvedValue(null);

      await expect(
        workspaceAccessor.applyPrSnapshotWithDispatchReset('ws-1', changedObservation)
      ).resolves.toEqual({ applied: false, dispatchReset: false });

      expect(mockPrUpdateMany).not.toHaveBeenCalled();
      expect(mockRatchetUpdateMany).not.toHaveBeenCalled();
    });
  });

  // PR discovery scheduling moved with its columns to
  // `workspace-pr.accessor.test.ts`.

  it('marks workspace as having had sessions with guarded updateMany', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await workspaceAccessor.markHasHadSessions('ws-1');

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', hasHadSessions: false },
      data: { hasHadSessions: true },
    });
  });

  // The auto-iteration compare-and-swaps moved with their columns; the guard,
  // the column names and both race outcomes are asserted in
  // workspace-auto-iteration.accessor.test.ts.

  it('joins the auto-iteration session onto the workspace execution context', async () => {
    mockFindUnique.mockResolvedValue({
      worktreePath: '/tmp/worktree',
      autoIteration: { sessionId: 'session-1' },
    });

    // The context spans both tables now, but the caller-facing shape is the flat
    // one it always was.
    await expect(workspaceAccessor.findAutoIterationExecutionContext('ws-1')).resolves.toEqual({
      worktreePath: '/tmp/worktree',
      autoIterationSessionId: 'session-1',
    });

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { worktreePath: true, autoIteration: { select: { sessionId: true } } },
    });
  });

  it('reads a missing auto-iteration row as a null session rather than throwing', async () => {
    mockFindUnique.mockResolvedValue({ worktreePath: '/tmp/worktree', autoIteration: null });

    await expect(workspaceAccessor.findAutoIterationExecutionContext('ws-1')).resolves.toEqual({
      worktreePath: '/tmp/worktree',
      autoIterationSessionId: null,
    });
  });

  it('returns null when the workspace itself is missing', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(workspaceAccessor.findAutoIterationExecutionContext('gone')).resolves.toBeNull();
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

      expect(result).toEqual([expect.objectContaining(staleWorkspace)]);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: {
          status: 'ARCHIVING',
          updatedAt: { lt: expect.any(Date) },
        },
        include: { project: true, pr: true, autoIteration: true },
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
