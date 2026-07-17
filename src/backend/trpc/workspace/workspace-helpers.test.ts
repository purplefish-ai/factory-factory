import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindById = vi.hoisted(() => vi.fn());
const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const workspaceDataService = {
  findById: (...args: Parameters<typeof mockFindById>) => mockFindById(...args),
  findByIdWithProject: (...args: Parameters<typeof mockFindByIdWithProject>) =>
    mockFindByIdWithProject(...args),
};

import {
  getWorkspaceOrThrow,
  getWorkspaceWithProjectAndWorktreeOrThrow,
  getWorkspaceWithProjectOrThrow,
  getWorkspaceWithWorktree,
  getWorkspaceWithWorktreeOrThrow,
} from './workspace-helpers';

describe('workspace helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns workspace when found', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', worktreePath: '/tmp/w1' });

    await expect(getWorkspaceOrThrow(workspaceDataService, 'w1')).resolves.toMatchObject({
      id: 'w1',
    });
    await expect(getWorkspaceWithWorktree(workspaceDataService, 'w1')).resolves.toEqual({
      workspace: expect.objectContaining({ id: 'w1' }),
      worktreePath: '/tmp/w1',
    });
  });

  it('throws NOT_FOUND when workspace is missing', async () => {
    mockFindById.mockResolvedValue(null);
    mockFindByIdWithProject.mockResolvedValue(null);

    await expect(getWorkspaceOrThrow(workspaceDataService, 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      getWorkspaceWithProjectOrThrow(workspaceDataService, 'missing')
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      getWorkspaceWithProjectAndWorktreeOrThrow(workspaceDataService, 'missing')
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns null for missing worktree and throws for required worktree', async () => {
    mockFindById.mockResolvedValue({ id: 'w1', worktreePath: null });

    await expect(getWorkspaceWithWorktree(workspaceDataService, 'w1')).resolves.toBeNull();
    await expect(getWorkspaceWithWorktreeOrThrow(workspaceDataService, 'w1')).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
  });

  it('returns workspace with project and worktree when valid', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w2',
      worktreePath: '/tmp/w2',
      project: { id: 'p1' },
    });

    await expect(getWorkspaceWithProjectOrThrow(workspaceDataService, 'w2')).resolves.toMatchObject(
      { id: 'w2' }
    );
    await expect(
      getWorkspaceWithProjectAndWorktreeOrThrow(workspaceDataService, 'w2')
    ).resolves.toEqual({
      workspace: expect.objectContaining({ id: 'w2' }),
      worktreePath: '/tmp/w2',
    });
  });
});
