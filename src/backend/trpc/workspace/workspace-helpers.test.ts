import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindByIdWithProject = vi.hoisted(() => vi.fn());
const mockFindWorktreeContext = vi.hoisted(() => vi.fn());
const workspaceDataService = {
  findByIdWithProject: (...args: Parameters<typeof mockFindByIdWithProject>) =>
    mockFindByIdWithProject(...args),
  findWorktreeContext: (...args: Parameters<typeof mockFindWorktreeContext>) =>
    mockFindWorktreeContext(...args),
};

import {
  getWorkspaceWithProjectOrThrow,
  getWorkspaceWithWorktree,
  getWorkspaceWithWorktreeOrThrow,
  getWorkspaceWorktreeContextOrThrow,
} from './workspace-helpers';

describe('workspace helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads worktree helpers through the narrow worktree context', async () => {
    const context = { id: 'w1', worktreePath: '/tmp/w1', project: { defaultBranch: 'trunk' } };
    mockFindWorktreeContext.mockResolvedValue(context);

    await expect(getWorkspaceWorktreeContextOrThrow(workspaceDataService, 'w1')).resolves.toBe(
      context
    );
    await expect(getWorkspaceWithWorktree(workspaceDataService, 'w1')).resolves.toEqual({
      workspace: context,
      worktreePath: '/tmp/w1',
    });
    await expect(getWorkspaceWithWorktreeOrThrow(workspaceDataService, 'w1')).resolves.toEqual({
      workspace: context,
      worktreePath: '/tmp/w1',
    });
    expect(mockFindWorktreeContext).toHaveBeenCalledWith('w1');
    expect(mockFindByIdWithProject).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when workspace is missing', async () => {
    mockFindWorktreeContext.mockResolvedValue(null);
    mockFindByIdWithProject.mockResolvedValue(null);

    await expect(
      getWorkspaceWorktreeContextOrThrow(workspaceDataService, 'missing')
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getWorkspaceWithWorktree(workspaceDataService, 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      getWorkspaceWithWorktreeOrThrow(workspaceDataService, 'missing')
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      getWorkspaceWithProjectOrThrow(workspaceDataService, 'missing')
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns null for missing worktree and throws for required worktree', async () => {
    mockFindWorktreeContext.mockResolvedValue({
      id: 'w1',
      worktreePath: null,
      project: { defaultBranch: 'main' },
    });

    await expect(getWorkspaceWithWorktree(workspaceDataService, 'w1')).resolves.toBeNull();
    await expect(getWorkspaceWithWorktreeOrThrow(workspaceDataService, 'w1')).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
  });

  it('returns workspace with project when found', async () => {
    mockFindByIdWithProject.mockResolvedValue({
      id: 'w2',
      worktreePath: '/tmp/w2',
      project: { id: 'p1' },
    });

    await expect(getWorkspaceWithProjectOrThrow(workspaceDataService, 'w2')).resolves.toMatchObject(
      { id: 'w2' }
    );
  });
});
