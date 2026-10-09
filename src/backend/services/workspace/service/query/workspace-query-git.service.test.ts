import { expect, it, vi } from 'vitest';
import { workspaceQueryService } from './workspace-query.service';
const { mockFindByIdWithProject, mockGetWorkspaceGitStats } = vi.hoisted(() => ({
  mockFindByIdWithProject: vi.fn(),
  mockGetWorkspaceGitStats: vi.fn(),
}));
vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: { findByIdWithProject: mockFindByIdWithProject },
}));
vi.mock('@/backend/services/workspace/service/worktree/git-ops.service', () => ({
  gitOpsService: { getWorkspaceGitStats: mockGetWorkspaceGitStats },
}));
it('hasChanges checks workspace metadata and git stats safely', async () => {
  mockFindByIdWithProject.mockResolvedValueOnce(null);
  await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);
  expect(mockGetWorkspaceGitStats).not.toHaveBeenCalled();

  mockFindByIdWithProject.mockResolvedValueOnce({
    id: 'w1',
    worktreePath: '/tmp/w1',
    project: { defaultBranch: 'main' },
  });
  mockGetWorkspaceGitStats.mockResolvedValueOnce({
    total: 0,
    additions: 0,
    deletions: 0,
    hasUncommitted: false,
  });
  await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);
  expect(mockGetWorkspaceGitStats).toHaveBeenLastCalledWith('/tmp/w1', 'main');

  mockFindByIdWithProject.mockResolvedValueOnce({
    id: 'w1',
    worktreePath: '/tmp/w1',
    project: { defaultBranch: 'main' },
  });
  mockGetWorkspaceGitStats.mockResolvedValueOnce({
    total: 1,
    additions: 1,
    deletions: 0,
    hasUncommitted: false,
  });
  await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(true);
  expect(mockGetWorkspaceGitStats).toHaveBeenLastCalledWith('/tmp/w1', 'main');

  mockFindByIdWithProject.mockResolvedValueOnce({
    id: 'w1',
    worktreePath: '/tmp/w1',
    project: { defaultBranch: 'main' },
  });
  mockGetWorkspaceGitStats.mockRejectedValueOnce(new Error('git failed'));
  await expect(workspaceQueryService.hasChanges('w1')).resolves.toBe(false);
});
