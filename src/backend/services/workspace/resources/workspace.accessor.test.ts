import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        prReviewLastCheckedAt: true,
      },
    });
  });
});
