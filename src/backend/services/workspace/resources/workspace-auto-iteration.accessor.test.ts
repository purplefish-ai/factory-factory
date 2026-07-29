import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindMany = vi.fn();
const mockUpdateMany = vi.fn();
const mockUpdateManyAndReturn = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspaceAutoIteration: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      updateManyAndReturn: (...args: unknown[]) => mockUpdateManyAndReturn(...args),
    },
  },
}));

import {
  flattenWorkspaceAutoIteration,
  WORKSPACE_AUTO_ITERATION_DEFAULTS,
  workspaceAutoIterationAccessor,
} from './workspace-auto-iteration.accessor';

describe('workspaceAutoIterationAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockReset();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    // The writes that publish a transition return the row they landed on, so
    // the caller never reads the mode back in a second statement.
    mockUpdateManyAndReturn.mockReset();
    mockUpdateManyAndReturn.mockResolvedValue([{ mode: 'AUTO_ITERATION' }]);
  });

  describe('flattenWorkspaceAutoIteration', () => {
    it('maps every column back to the flat name callers consume', () => {
      expect(
        flattenWorkspaceAutoIteration({
          workspaceId: 'ws-1',
          mode: 'AUTO_ITERATION',
          status: 'RUNNING',
          config: { testCommand: 'pnpm test' },
          progress: { currentIteration: 7 },
          sessionId: 'sess-1',
        })
      ).toEqual({
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        autoIterationConfig: { testCommand: 'pnpm test' },
        autoIterationProgress: { currentIteration: 7 },
        autoIterationSessionId: 'sess-1',
      });
    });

    it('substitutes the column defaults when no row was joined', () => {
      expect(flattenWorkspaceAutoIteration(null)).toEqual(WORKSPACE_AUTO_ITERATION_DEFAULTS);
      expect(flattenWorkspaceAutoIteration(undefined)).toEqual(WORKSPACE_AUTO_ITERATION_DEFAULTS);
      // The shape a workspace that never touched the feature reads as, which was
      // every row on the database this split was developed against.
      expect(WORKSPACE_AUTO_ITERATION_DEFAULTS).toEqual({
        mode: 'STANDARD',
        autoIterationStatus: null,
        autoIterationConfig: null,
        autoIterationProgress: null,
        autoIterationSessionId: null,
      });
    });

    it('returns a fresh object each time, so a caller cannot mutate the defaults', () => {
      const first = flattenWorkspaceAutoIteration(null);
      first.mode = 'AUTO_ITERATION';

      expect(flattenWorkspaceAutoIteration(null).mode).toBe('STANDARD');
    });
  });

  describe('unconditional writes', () => {
    it('translates each setter to its column', async () => {
      await workspaceAutoIterationAccessor.setStatus('ws-1', 'RUNNING');
      expect(mockUpdateManyAndReturn).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { status: 'RUNNING' },
        select: { mode: true },
      });

      await workspaceAutoIterationAccessor.setProgress('ws-1', { currentIteration: 3 });
      expect(mockUpdateManyAndReturn).toHaveBeenLastCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { progress: { currentIteration: 3 } },
        select: { mode: true },
      });

      await workspaceAutoIterationAccessor.setSession('ws-1', 'sess-2');
      expect(mockUpdateManyAndReturn).toHaveBeenLastCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { sessionId: 'sess-2' },
        select: { mode: true },
      });
    });

    it('reports the mode from the statement that wrote the status', async () => {
      // Not from a second read: the pair is published to the snapshot stream, so
      // it has to describe a row that existed rather than one row's status
      // beside another read's mode.
      mockUpdateManyAndReturn.mockResolvedValue([{ mode: 'AUTO_ITERATION' }]);

      await expect(workspaceAutoIterationAccessor.setStatus('ws-1', 'RUNNING')).resolves.toEqual({
        mode: 'AUTO_ITERATION',
        status: 'RUNNING',
      });
    });

    it('clears the session with an explicit null rather than dropping the key', async () => {
      await workspaceAutoIterationAccessor.setSession('ws-1', null);

      expect(mockUpdateManyAndReturn).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { sessionId: null },
        select: { mode: true },
      });
    });

    it('throws when no row matched, so a discarded write is not reported as success', async () => {
      // The pre-split path used `prisma.workspace.update`, which threw on a
      // missing row. The filter-based write does not, so the empty result is
      // checked here.
      mockUpdateManyAndReturn.mockResolvedValue([]);

      await expect(workspaceAutoIterationAccessor.setStatus('gone', 'FAILED')).rejects.toThrow(
        'WorkspaceAutoIteration row not found for workspace: gone'
      );
    });
  });

  describe('finishIfSessionMatches', () => {
    it('guards on the session and clears it as it settles', async () => {
      // Returns the mode alongside the outcome so the caller can announce the
      // transition to the snapshot stream without a second read.
      await expect(
        workspaceAutoIterationAccessor.finishIfSessionMatches('ws-1', 'sess-1', 'COMPLETED')
      ).resolves.toEqual({ settled: true, mode: 'AUTO_ITERATION' });

      expect(mockUpdateManyAndReturn).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', sessionId: 'sess-1' },
        data: { status: 'COMPLETED', sessionId: null },
        select: { mode: true },
      });
    });

    it('reports no settlement when the loop has already moved to another session', async () => {
      mockUpdateManyAndReturn.mockResolvedValue([]);

      await expect(
        workspaceAutoIterationAccessor.finishIfSessionMatches('ws-1', 'stale', 'FAILED')
      ).resolves.toEqual({ settled: false, mode: null });
    });
  });

  describe('clearSessionIfMatches', () => {
    it('clears only when the session on the row is the one clearing it', async () => {
      await expect(
        workspaceAutoIterationAccessor.clearSessionIfMatches('ws-1', 'sess-1')
      ).resolves.toBe(true);

      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', sessionId: 'sess-1' },
        data: { sessionId: null },
      });
    });

    it('reports false on a lost race', async () => {
      mockUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceAutoIterationAccessor.clearSessionIfMatches('ws-1', 'stale')
      ).resolves.toBe(false);
    });
  });

  describe('resetStaleRunningStatuses', () => {
    it('returns an empty array and skips the update when nothing is stale', async () => {
      mockFindMany.mockResolvedValue([]);

      await expect(workspaceAutoIterationAccessor.resetStaleRunningStatuses()).resolves.toEqual([]);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('fails the stale loops, clears their sessions, and reports them under `id`', async () => {
      mockFindMany.mockResolvedValue([
        { workspaceId: 'ws-1', sessionId: 'sess-1' },
        { workspaceId: 'ws-2', sessionId: null },
      ]);

      // The caller emits one status-changed event per entry and keyed off `id`
      // before the split, so the column rename stops at this boundary.
      await expect(workspaceAutoIterationAccessor.resetStaleRunningStatuses()).resolves.toEqual([
        { id: 'ws-1' },
        { id: 'ws-2' },
      ]);

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { status: 'RUNNING' },
        select: { workspaceId: true, sessionId: true },
      });
      // Each write is guarded on the session the row was read with, so a loop
      // that started between the two steps is not failed by this sweep.
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', status: 'RUNNING', sessionId: 'sess-1' },
        data: { status: 'FAILED', sessionId: null },
      });
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-2', status: 'RUNNING', sessionId: null },
        data: { status: 'FAILED', sessionId: null },
      });
    });

    it('omits a row whose loop restarted under a new session between the two steps', async () => {
      mockFindMany.mockResolvedValue([
        { workspaceId: 'ws-restarted', sessionId: 'old-session' },
        { workspaceId: 'ws-still-stale', sessionId: 'dead-session' },
      ]);
      // The restarted row is RUNNING again under a different session, so its
      // guard matches nothing and the sweep leaves the live loop alone.
      mockUpdateMany.mockImplementation((args: { where: { sessionId: string | null } }) =>
        Promise.resolve({ count: args.where.sessionId === 'old-session' ? 0 : 1 })
      );

      // Only the row actually reset is reported, so no status-changed event is
      // emitted for a workspace this did not touch.
      await expect(workspaceAutoIterationAccessor.resetStaleRunningStatuses()).resolves.toEqual([
        { id: 'ws-still-stale' },
      ]);
    });

    it('leaves PAUSED, COMPLETED and FAILED alone', async () => {
      // PAUSED is a state the user chose; the two terminal states are results
      // they have not acknowledged. Only RUNNING describes a loop a restart
      // broke.
      mockFindMany.mockResolvedValue([]);

      await workspaceAutoIterationAccessor.resetStaleRunningStatuses();

      const [call] = mockFindMany.mock.calls as [[{ where: { status: string } }]];
      expect(call[0].where.status).toBe('RUNNING');
    });
  });
});
