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
    it('reads both closed and merged off the PR, and only `enabled` off the ratchet', async () => {
      // These used to be two conditions on two tables — `pr.state != CLOSED` and
      // `ratchet.state != MERGED` — asking the same question of a cache and of a
      // copy of that cache.
      mockWorkspaceFindMany.mockResolvedValue([]);

      await workspaceRatchetAccessor.findWithPRsForRatchet();

      expect(mockWorkspaceFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'READY',
            pr: { url: { not: null }, state: { notIn: ['CLOSED', 'MERGED'] } },
            ratchet: { enabled: true },
          },
          orderBy: { ratchet: { lastCheckedAt: 'asc' } },
        })
      );
    });

    it('flattens the joined ratchet and PR rows onto each candidate', async () => {
      mockWorkspaceFindMany.mockResolvedValue([
        {
          id: 'ws-1',
          defaultSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetSessionProvider: 'WORKSPACE_DEFAULT',
          ratchet: ratchetRow(),
          pr: {
            url: 'https://github.com/org/repo/pull/1',
            number: 1,
            state: 'OPEN',
            reviewState: null,
            ciStatus: 'FAILURE',
            hasMergeConflict: false,
            reviewLastCheckedAt: null,
          },
        },
      ]);

      const [candidate] = await workspaceRatchetAccessor.findWithPRsForRatchet();

      expect(candidate).toMatchObject({
        id: 'ws-1',
        prUrl: 'https://github.com/org/repo/pull/1',
        prNumber: 1,
        prState: 'OPEN',
        prCiStatus: 'FAILURE',
        prHasMergeConflict: false,
        // Projected from the PR row above, not read from the ratchet row.
        ratchetState: 'CI_FAILED',
        ratchetDispatchSnapshotKey: 'snapshot-1',
        ratchetDispatchRetryCount: 2,
      });
      expect(candidate).not.toHaveProperty('ratchet');
      expect(candidate).not.toHaveProperty('pr');
    });

    it('drops a candidate whose PR row carries no URL', async () => {
      mockWorkspaceFindMany.mockResolvedValue([
        {
          id: 'ws-1',
          defaultSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetSessionProvider: 'WORKSPACE_DEFAULT',
          ratchet: ratchetRow(),
          pr: null,
        },
      ]);

      await expect(workspaceRatchetAccessor.findWithPRsForRatchet()).resolves.toEqual([]);
    });

    it('finds one candidate by id with READY and PR filters', async () => {
      mockWorkspaceFindFirst.mockResolvedValue(null);

      await expect(workspaceRatchetAccessor.findForRatchetById('ws-1')).resolves.toBeNull();

      expect(mockWorkspaceFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ws-1', status: 'READY', pr: { url: { not: null } } },
        })
      );
    });

    it('projects the state from the PR row it joins in for the snapshot', async () => {
      mockWorkspaceFindUnique.mockResolvedValue({
        status: 'READY',
        ratchet: ratchetRow(),
        pr: { state: 'OPEN', ciStatus: 'PENDING', hasMergeConflict: false, reviewState: null },
      });

      await expect(workspaceRatchetAccessor.findSnapshotProjection('ws-1')).resolves.toEqual({
        status: 'READY',
        ratchetEnabled: true,
        ratchetState: 'CI_RUNNING',
        ratchetDispatchOutcome: 'RUNNING',
        ratchetDispatchRetryCount: 2,
      });

      expect(mockWorkspaceFindUnique).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        select: { status: true, ratchet: true, pr: true },
      });
    });

    it('projects IDLE for a disabled workspace regardless of the PR', async () => {
      mockWorkspaceFindUnique.mockResolvedValue({
        status: 'READY',
        ratchet: ratchetRow({ enabled: false }),
        pr: { state: 'OPEN', ciStatus: 'FAILURE', hasMergeConflict: true, reviewState: null },
      });

      await expect(workspaceRatchetAccessor.findSnapshotProjection('ws-1')).resolves.toMatchObject({
        ratchetEnabled: false,
        ratchetState: 'IDLE',
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

    it('stamps the check timestamp only while ratcheting is enabled', async () => {
      const checkedAt = new Date('2026-01-01T00:00:00.000Z');
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await expect(workspaceRatchetAccessor.recordCheckIfEnabled('ws-1', checkedAt)).resolves.toBe(
        true
      );

      expect(mockRatchetUpdateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws-1', enabled: true },
        data: { lastCheckedAt: checkedAt },
      });
    });

    it('returns false when ratcheting was disabled while the check ran', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 0 });

      await expect(workspaceRatchetAccessor.recordCheckIfEnabled('ws-1', new Date())).resolves.toBe(
        false
      );
    });

    it('never writes a state column: nothing here can name one', async () => {
      mockRatchetUpdateMany.mockResolvedValue({ count: 1 });

      await workspaceRatchetAccessor.recordCheckIfEnabled('ws-1', new Date());
      await workspaceRatchetAccessor.disable('ws-1');
      await workspaceRatchetAccessor.enable('ws-1');

      for (const call of mockRatchetUpdateMany.mock.calls) {
        expect(call[0].data).not.toHaveProperty('state');
        expect(call[0].where).not.toHaveProperty('state');
      }
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
