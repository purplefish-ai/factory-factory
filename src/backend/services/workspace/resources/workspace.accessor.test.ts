import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();
const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn();
const mockUpdateMany = vi.fn();
const mockExecuteRaw = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
  },
}));

import { workspaceAccessor } from './workspace.accessor';

describe('workspaceAccessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          ratchetEnabled: false,
        }),
      });
    });

    it('keeps ratchetEnabled undefined when not provided', async () => {
      mockCreate.mockResolvedValue({ id: 'ws-2' });

      await workspaceAccessor.create({
        projectId: 'project-1',
        name: 'Manual workspace',
      });

      expect(mockCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: 'project-1',
          name: 'Manual workspace',
          ratchetEnabled: undefined,
        }),
      });
    });
  });

  it('throws for mutually-exclusive status filters in findByProjectIdWithSessions', () => {
    expect(() =>
      workspaceAccessor.findByProjectIdWithSessions('project-1', {
        status: 'READY',
        excludeStatuses: ['FAILED'],
      })
    ).toThrow('Cannot specify both status and excludeStatuses filters');
    expect(mockFindMany).not.toHaveBeenCalled();
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

  it('marks workspace as having had sessions with guarded updateMany', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await workspaceAccessor.markHasHadSessions('ws-1');

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', hasHadSessions: false },
      data: { hasHadSessions: true },
    });
  });

  it('records ratchet dispatch only when ratchet is enabled', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspaceAccessor.recordRatchetDispatchIfEnabled('ws-1', {
        sessionId: 'session-1',
        snapshotKey: 'snapshot-1',
        retryCount: 2,
      })
    ).resolves.toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', ratchetEnabled: true },
      data: {
        ratchetActiveSessionId: 'session-1',
        ratchetLastCiRunId: 'snapshot-1',
        ratchetDispatchOutcome: 'RUNNING',
        ratchetDispatchRetryCount: 2,
      },
    });
  });

  it('returns false when ratchet dispatch conditional update affects no rows', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      workspaceAccessor.recordRatchetDispatchIfEnabled('ws-1', {
        sessionId: 'session-1',
        snapshotKey: 'snapshot-1',
        retryCount: 0,
      })
    ).resolves.toBe(false);
  });

  it('adopts an already-running fixer session without touching the dispatch snapshot', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspaceAccessor.adoptRatchetActiveSessionIfEnabled('ws-1', 'session-1')
    ).resolves.toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', ratchetEnabled: true },
      data: { ratchetActiveSessionId: 'session-1', ratchetDispatchOutcome: 'RUNNING' },
    });
  });

  it('settles ratchet session end only when the pointer still matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspaceAccessor.recordRatchetSessionEnd('ws-1', 'session-1', 'DIED')
    ).resolves.toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', ratchetActiveSessionId: 'session-1' },
      data: { ratchetActiveSessionId: null, ratchetDispatchOutcome: 'DIED' },
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

  it('returns false when ratchet session end conditional update affects no rows', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      workspaceAccessor.recordRatchetSessionEnd('ws-1', 'session-1', 'COMPLETED')
    ).resolves.toBe(false);
  });

  it('transitions ratchet state only when enabled and fromState still matches', async () => {
    const checkedAt = new Date('2026-01-01T00:00:00.000Z');
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspaceAccessor.transitionRatchetStateIfEnabled('ws-1', 'CI_RUNNING', {
        ratchetState: 'CI_FAILED',
        ratchetLastCheckedAt: checkedAt,
      })
    ).resolves.toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', ratchetEnabled: true, ratchetState: 'CI_RUNNING' },
      data: {
        ratchetState: 'CI_FAILED',
        ratchetLastCheckedAt: checkedAt,
      },
    });
  });

  it('returns false when ratchet state transition loses the compare-and-swap', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      workspaceAccessor.transitionRatchetStateIfEnabled('ws-1', 'CI_RUNNING', {
        ratchetState: 'READY',
        ratchetLastCheckedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    ).resolves.toBe(false);
  });

  it('settles ratchet state to IDLE only while disabled and fromState still matches', async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      workspaceAccessor.settleRatchetIdleWhileDisabled('ws-1', 'CI_FAILED')
    ).resolves.toBe(true);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', ratchetEnabled: false, ratchetState: 'CI_FAILED' },
      data: {
        ratchetState: 'IDLE',
        ratchetLastCheckedAt: expect.any(Date),
      },
    });
  });

  it('returns false when the disabled-settle compare-and-swap affects no rows', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      workspaceAccessor.settleRatchetIdleWhileDisabled('ws-1', 'CI_FAILED')
    ).resolves.toBe(false);
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

  it('finds one ratchet candidate by id with READY and PR filters', async () => {
    mockFindFirst.mockResolvedValue({ id: 'ws-1', prUrl: 'https://github.com/org/repo/pull/1' });

    await workspaceAccessor.findForRatchetById('ws-1');

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'ws-1',
        status: 'READY',
        prUrl: { not: null },
      },
      select: {
        id: true,
        prUrl: true,
        prNumber: true,
        prState: true,
        prCiStatus: true,
        defaultSessionProvider: true,
        ratchetSessionProvider: true,
        ratchetEnabled: true,
        ratchetState: true,
        ratchetActiveSessionId: true,
        ratchetLastCiRunId: true,
        ratchetDispatchOutcome: true,
        ratchetDispatchRetryCount: true,
        prReviewLastCheckedAt: true,
      },
    });
  });
});
