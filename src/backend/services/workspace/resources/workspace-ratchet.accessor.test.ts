import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkspaceFindMany = vi.fn();
const mockWorkspaceFindFirst = vi.fn();
const mockWorkspaceFindUnique = vi.fn();
const mockRatchetUpdateMany = vi.fn();
const mockRatchetFindUnique = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findMany: (...args: unknown[]) => mockWorkspaceFindMany(...args),
      findFirst: (...args: unknown[]) => mockWorkspaceFindFirst(...args),
      findUnique: (...args: unknown[]) => mockWorkspaceFindUnique(...args),
    },
    workspaceRatchet: {
      updateMany: (...args: unknown[]) => mockRatchetUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockRatchetFindUnique(...args),
    },
  },
}));

import {
  flattenWorkspaceRatchet,
  WORKSPACE_RATCHET_DEFAULTS,
  type WorkspaceRatchetRow,
  workspaceRatchetAccessor,
} from './workspace-ratchet.accessor';

/** A persisted row, with the field names the table uses. */
function ratchetRow(overrides: Partial<WorkspaceRatchetRow> = {}): WorkspaceRatchetRow {
  return {
    workspaceId: 'ws-1',
    enabled: true,
    state: 'CI_RUNNING' as const,
    lastCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
    activeSessionId: 'session-1',
    dispatchSnapshotKey: 'snapshot-1',
    dispatchOutcome: 'RUNNING' as const,
    dispatchRetryCount: 2,
    ...overrides,
  };
}

describe('flattenWorkspaceRatchet', () => {
  it('maps the table field names onto the caller-facing ratchet* names', () => {
    expect(flattenWorkspaceRatchet(ratchetRow())).toEqual({
      ratchetEnabled: true,
      ratchetState: 'CI_RUNNING',
      ratchetLastCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
      ratchetActiveSessionId: 'session-1',
      ratchetDispatchSnapshotKey: 'snapshot-1',
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 2,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('falls back to the column defaults when the row is %s', (_label, missing) => {
    expect(flattenWorkspaceRatchet(missing)).toEqual(WORKSPACE_RATCHET_DEFAULTS);
  });

  it('returns a fresh object so callers cannot mutate the shared defaults', () => {
    const first = flattenWorkspaceRatchet(null);
    first.ratchetEnabled = false;

    expect(flattenWorkspaceRatchet(null).ratchetEnabled).toBe(true);
    expect(WORKSPACE_RATCHET_DEFAULTS.ratchetEnabled).toBe(true);
  });
});

describe('workspaceRatchetAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('candidate reads', () => {
    it('filters candidates on the ratchet relation and orders by its last check', async () => {
      mockWorkspaceFindMany.mockResolvedValue([]);

      await workspaceRatchetAccessor.findWithPRsForRatchet();

      expect(mockWorkspaceFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'READY',
            prUrl: { not: null },
            prState: { not: 'CLOSED' },
            ratchet: { enabled: true, state: { not: 'MERGED' } },
          },
          orderBy: { ratchet: { lastCheckedAt: 'asc' } },
        })
      );
    });

    it('flattens the joined ratchet onto each candidate', async () => {
      mockWorkspaceFindMany.mockResolvedValue([
        {
          id: 'ws-1',
          prUrl: 'https://github.com/org/repo/pull/1',
          prNumber: 1,
          prState: 'OPEN',
          prCiStatus: 'FAILURE',
          defaultSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetSessionProvider: 'WORKSPACE_DEFAULT',
          prReviewLastCheckedAt: null,
          ratchet: ratchetRow(),
        },
      ]);

      const [candidate] = await workspaceRatchetAccessor.findWithPRsForRatchet();

      expect(candidate).toMatchObject({
        id: 'ws-1',
        ratchetState: 'CI_RUNNING',
        ratchetDispatchSnapshotKey: 'snapshot-1',
        ratchetDispatchRetryCount: 2,
      });
      expect(candidate).not.toHaveProperty('ratchet');
    });

    it('finds one candidate by id with READY and PR filters', async () => {
      mockWorkspaceFindFirst.mockResolvedValue(null);

      await expect(workspaceRatchetAccessor.findForRatchetById('ws-1')).resolves.toBeNull();

      expect(mockWorkspaceFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ws-1', status: 'READY', prUrl: { not: null } },
        })
      );
    });

    it('reads only status and the ratchet row for the snapshot projection', async () => {
      mockWorkspaceFindUnique.mockResolvedValue({ status: 'READY', ratchet: ratchetRow() });

      await expect(workspaceRatchetAccessor.findSnapshotProjection('ws-1')).resolves.toEqual({
        status: 'READY',
        ratchetEnabled: true,
        ratchetState: 'CI_RUNNING',
        ratchetDispatchOutcome: 'RUNNING',
        ratchetDispatchRetryCount: 2,
      });

      expect(mockWorkspaceFindUnique).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        select: { status: true, ratchet: true },
      });
    });

    it('returns null for a snapshot projection of a missing workspace', async () => {
      mockWorkspaceFindUnique.mockResolvedValue(null);

      await expect(workspaceRatchetAccessor.findSnapshotProjection('ws-gone')).resolves.toBeNull();
    });
  });

  describe('guarded writes', () => {
    it('records a dispatch only while ratcheting is enabled', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceRatchetAccessor.recordDispatchIfEnabled('ws-1', {
          sessionId: 'session-1',
          snapshotKey: 'snapshot-1',
          retryCount: 2,
        })
      ).resolves.toBe(true);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', enabled: true },
        data: {
          activeSessionId: 'session-1',
          dispatchSnapshotKey: 'snapshot-1',
          dispatchOutcome: 'RUNNING',
          dispatchRetryCount: 2,
        },
      });
    });

    it('returns false when the dispatch write affects no rows', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRatchetAccessor.recordDispatchIfEnabled('ws-1', {
          sessionId: 'session-1',
          snapshotKey: 'snapshot-1',
          retryCount: 0,
        })
      ).resolves.toBe(false);
    });

    it('adopts a running fixer session without touching the dispatch snapshot', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceRatchetAccessor.adoptActiveSessionIfEnabled('ws-1', 'session-1')
      ).resolves.toBe(true);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', enabled: true },
        data: { activeSessionId: 'session-1', dispatchOutcome: 'RUNNING' },
      });
    });

    it('settles a session end only while the pointer still names that session', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceRatchetAccessor.recordSessionEnd('ws-1', 'session-1', 'DIED')
      ).resolves.toBe(true);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', activeSessionId: 'session-1' },
        data: { activeSessionId: null, dispatchOutcome: 'DIED' },
      });
    });

    it('returns false when the session-end write affects no rows', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRatchetAccessor.recordSessionEnd('ws-1', 'session-1', 'COMPLETED')
      ).resolves.toBe(false);
    });

    it('transitions state only when enabled and the fromState still matches', async () => {
      const checkedAt = new Date('2026-01-01T00:00:00.000Z');
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceRatchetAccessor.transitionStateIfEnabled('ws-1', 'CI_RUNNING', {
          ratchetState: 'CI_FAILED',
          ratchetLastCheckedAt: checkedAt,
        })
      ).resolves.toBe(true);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', enabled: true, state: 'CI_RUNNING' },
        data: { state: 'CI_FAILED', lastCheckedAt: checkedAt },
      });
    });

    it('returns false when the state transition loses the compare-and-swap', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRatchetAccessor.transitionStateIfEnabled('ws-1', 'CI_RUNNING', {
          ratchetState: 'READY',
          ratchetLastCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
        })
      ).resolves.toBe(false);
    });

    it('settles state to IDLE only while disabled and the fromState still matches', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        workspaceRatchetAccessor.settleIdleWhileDisabled('ws-1', 'CI_FAILED')
      ).resolves.toBe(true);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', enabled: false, state: 'CI_FAILED' },
        data: { state: 'IDLE', lastCheckedAt: expect.any(Date) },
      });
    });

    it('returns false when the disabled-settle compare-and-swap affects no rows', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRatchetAccessor.settleIdleWhileDisabled('ws-1', 'CI_FAILED')
      ).resolves.toBe(false);
    });

    it('clears the active-session pointer only when it names that session', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(workspaceRatchetAccessor.clearActiveSession('ws-1', 'session-1')).resolves.toBe(
        true
      );

      // Scoped to the session: the prompt-failure path that calls this never
      // recorded its own dispatch, so an unscoped clear would evict whichever
      // dispatch does hold the pointer.
      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', activeSessionId: 'session-1' },
        data: { activeSessionId: null },
      });
    });

    it('leaves a newer dispatch pointer alone when the failed session does not own it', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRatchetAccessor.clearActiveSession('ws-1', 'session-that-never-ran')
      ).resolves.toBe(false);
    });

    it('clears everything the ratchet was tracking on disable', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceRatchetAccessor.disable('ws-1');

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: {
          enabled: false,
          state: 'IDLE',
          activeSessionId: null,
          dispatchSnapshotKey: null,
          dispatchOutcome: null,
          dispatchRetryCount: 0,
        },
      });
    });

    it('leaves the progression alone on enable', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceRatchetAccessor.enable('ws-1');

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        data: { enabled: true },
      });
    });
  });

  describe('dispatch reset inside a PR-aggregate transaction', () => {
    function transactionClient() {
      return {
        workspaceRatchet: {
          findUnique: mockRatchetFindUnique,
          updateMany: mockRatchetUpdateMany,
        },
      } as unknown as Parameters<typeof workspaceRatchetAccessor.readDispatchGuard>[0];
    }

    it('reads the dispatch guard through the caller transaction', async () => {
      mockRatchetFindUnique.mockResolvedValue(null);

      await workspaceRatchetAccessor.readDispatchGuard(transactionClient(), 'ws-1');

      expect(mockRatchetFindUnique).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1' },
        select: {
          activeSessionId: true,
          dispatchSnapshotKey: true,
          dispatchOutcome: true,
          dispatchRetryCount: true,
        },
      });
    });

    it('resets a settled dispatch guarded on every field it was decided from', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });
      const guard = {
        activeSessionId: null,
        dispatchSnapshotKey: 'snapshot-1',
        dispatchOutcome: 'DIED' as const,
        dispatchRetryCount: 3,
      };

      await expect(
        workspaceRatchetAccessor.resetSettledDispatch(transactionClient(), 'ws-1', guard)
      ).resolves.toBe(true);

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', ...guard },
        data: { dispatchOutcome: null, dispatchRetryCount: 0 },
      });
    });

    it('reports no reset when a newer dispatch won the race', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        workspaceRatchetAccessor.resetSettledDispatch(transactionClient(), 'ws-1', {
          activeSessionId: null,
          dispatchSnapshotKey: 'snapshot-1',
          dispatchOutcome: 'COMPLETED',
          dispatchRetryCount: 0,
        })
      ).resolves.toBe(false);
    });
  });
});
