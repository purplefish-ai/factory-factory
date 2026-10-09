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
          prMonitoring: { create: { enabled: false, eventEpoch: 0 } },
          prDiscovery: { create: {} },
          runScript: { create: {} },
          autoIteration: { create: { mode: undefined, config: undefined } },
        }),
        include: {
          prMonitoring: true,
          prs: { where: { detachedAt: null } },
          prDiscovery: true,
          runScript: true,
          autoIteration: true,
          _count: {
            select: {
              prEvents: {
                where: {
                  state: { in: ['PENDING', 'DISPATCHING'] },
                  OR: [{ prId: null }, { pr: { detachedAt: null } }],
                },
              },
            },
          },
        },
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
          prMonitoring: { create: { enabled: false, eventEpoch: 0 } },
          prDiscovery: { create: {} },
          runScript: { create: {} },
          autoIteration: { create: { mode: undefined, config: undefined } },
        }),
        include: {
          prMonitoring: true,
          prs: { where: { detachedAt: null } },
          prDiscovery: true,
          runScript: true,
          autoIteration: true,
          _count: {
            select: {
              prEvents: {
                where: {
                  state: { in: ['PENDING', 'DISPATCHING'] },
                  OR: [{ prId: null }, { pr: { detachedAt: null } }],
                },
              },
            },
          },
        },
      });
    });

    it('always creates the ratchet row, so no workspace can exist without one', async () => {
      mockCreate.mockResolvedValue({ id: 'ws-3' });

      await workspaceAccessor.create({ projectId: 'project-1', name: 'Manual workspace' });

      const [{ data }] = mockCreate.mock.calls[0] as [{ data: { prMonitoring?: unknown } }];
      expect(data.prMonitoring).toBeDefined();
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
        prMonitoring: true,
        prs: { where: { detachedAt: null } },
        prDiscovery: true,
        runScript: true,
        autoIteration: true,
        _count: {
          select: {
            prEvents: {
              where: {
                state: { in: ['PENDING', 'DISPATCHING'] },
                OR: [{ prId: null }, { pr: { detachedAt: null } }],
              },
            },
          },
        },
      },
    });
  });

  it('short-circuits findByIdsWithProject for empty id arrays', async () => {
    await expect(workspaceAccessor.findByIdsWithProject([])).resolves.toEqual([]);

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('queries IDs with project include', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'ws-2' }]);

    await workspaceAccessor.findByIdsWithProject(['ws-2']);

    expect(mockFindMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['ws-2'] } },
      include: {
        project: true,
        prMonitoring: { select: { enabled: true } },
        prs: { where: { detachedAt: null } },
        prDiscovery: true,
        autoIteration: true,
      },
    });
  });

  describe('ratchetState projection at the flatten boundary', () => {
    function row(
      pr: Record<string, unknown>,
      ratchet: Record<string, unknown> = { enabled: true }
    ) {
      return {
        id: 'ws-1',
        prMonitoring: ratchet,
        prs: [{ ...pr, url: 'https://github.com/org/repo/pull/1' }],
      };
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
            prMonitoring: true,
            prs: { where: { detachedAt: null } },
            prDiscovery: true,
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
      mockFindUnique.mockResolvedValue({ id: 'ws-1', prMonitoring: null, prs: [] });

      await expect(workspaceAccessor.findById('ws-1')).resolves.toMatchObject({
        // Missing monitoring configuration defaults to disabled.
        ratchetEnabled: false,
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
        include: {
          project: true,
          prMonitoring: { select: { enabled: true } },
          prs: { where: { detachedAt: null } },
          prDiscovery: true,
          autoIteration: true,
        },
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
