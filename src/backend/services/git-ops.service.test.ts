import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGitCommand = vi.hoisted(() => vi.fn());
const mockGetSnapshot = vi.hoisted(() => vi.fn());
const mockGetStats = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockGitStateInvalidate = vi.hoisted(() => vi.fn());
const mockGitStateRemove = vi.hoisted(() => vi.fn());

const mockGitClient = vi.hoisted(() => ({
  checkWorktreeExists: vi.fn(),
  deleteWorktree: vi.fn(),
  isBlankRepository: vi.fn(),
  branchExists: vi.fn(),
  createWorktree: vi.fn(),
  createWorktreeFromExistingBranch: vi.fn(),
  getWorktreePath: vi.fn(),
  listWorktreesWithBranches: vi.fn(),
}));

vi.mock('@/backend/lib/shell', () => ({
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

vi.mock('@/backend/lib/file-helpers', () => ({
  pathExists: (...args: unknown[]) => mockPathExists(...args),
}));

vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => mockRm(...args),
}));

vi.mock('@/backend/clients/git.client', () => ({
  GitClientFactory: {
    forProject: () => mockGitClient,
  },
}));

vi.mock('@/backend/services/workspace-git-state.service', () => ({
  getStats: (...args: unknown[]) => mockGetStats(...args),
  workspaceGitStateService: {
    getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    invalidate: mockGitStateInvalidate,
    remove: mockGitStateRemove,
  },
}));

import { gitOpsService } from './git-ops.service';

const project = {
  repoPath: '/repo',
  worktreeBasePath: '/repo/worktrees',
};

describe('gitOpsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGitClient.getWorktreePath.mockImplementation((name: string) => `/repo/worktrees/${name}`);
  });

  it('derives workspace git stats from the shared snapshot', async () => {
    const snapshot = { base: { stats: { total: 3, additions: 2, deletions: 1 } } };
    const stats = { total: 3, additions: 2, deletions: 1, hasUncommitted: false };
    mockGetSnapshot.mockResolvedValue(snapshot);
    mockGetStats.mockReturnValue(stats);

    await expect(gitOpsService.getWorkspaceGitStats('/repo/w1', 'main')).resolves.toEqual(stats);
    expect(mockGetSnapshot).toHaveBeenCalledWith({
      worktreePath: '/repo/w1',
      defaultBranch: 'main',
    });
    expect(mockGetStats).toHaveBeenCalledWith(snapshot);
  });

  it('commitIfNeeded skips invalid repo, validates status, and commits when requested', async () => {
    mockGitCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'not a repo' });
    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1', true)).resolves.toBeUndefined();

    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'status failed' });
    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1', true)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });

    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1', true)).resolves.toBeUndefined();

    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' });
    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1', false)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '[main] Archive workspace W1', stderr: '' });

    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1', true)).resolves.toBeUndefined();
    expect(mockGitCommand).toHaveBeenCalledWith(['add', '-A'], '/repo/w1');
    expect(mockGitCommand).toHaveBeenCalledWith(
      ['commit', '-m', 'Archive workspace W1', '--no-verify'],
      '/repo/w1'
    );
    expect(mockGitStateInvalidate).toHaveBeenCalledOnce();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/w1');
  });

  it('invalidates staged archive changes when the commit fails', async () => {
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'commit failed' });

    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1', true)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(mockGitStateInvalidate).toHaveBeenCalledOnce();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/w1');
  });

  it('removeWorktree uses git when registered and fs fallback otherwise', async () => {
    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([{ path: '/repo/worktrees/w1' }]);

    await gitOpsService.removeWorktree('/repo/worktrees/w1', project);
    expect(mockGitClient.deleteWorktree).toHaveBeenCalledWith('w1');

    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([]);
    mockPathExists.mockResolvedValueOnce(true);

    await gitOpsService.removeWorktree('/repo/worktrees/w2', project);
    expect(mockRm).toHaveBeenCalledWith('/repo/worktrees/w2', { recursive: true, force: true });

    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([]);
    mockPathExists.mockResolvedValueOnce(false);

    await gitOpsService.removeWorktree('/repo/worktrees/w3', project);
    expect(mockRm).toHaveBeenCalledTimes(1);
  });

  it('evicts Git state after successful registered worktree removal', async () => {
    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([{ path: '/repo/worktrees/w1' }]);

    await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

    expect(mockGitClient.deleteWorktree).toHaveBeenCalledWith('w1');
    expect(mockGitStateRemove).toHaveBeenCalledOnce();
    expect(mockGitStateRemove).toHaveBeenCalledWith('/repo/worktrees/w1');
  });

  it('evicts Git state after successful filesystem-fallback removal', async () => {
    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([]);
    mockPathExists.mockResolvedValueOnce(true);

    await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

    expect(mockRm).toHaveBeenCalledWith('/repo/worktrees/w1', { recursive: true, force: true });
    expect(mockGitStateRemove).toHaveBeenCalledOnce();
    expect(mockGitStateRemove).toHaveBeenCalledWith('/repo/worktrees/w1');
  });

  it('does not evict Git state when registered worktree removal fails', async () => {
    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([{ path: '/repo/worktrees/w1' }]);
    mockGitClient.deleteWorktree.mockRejectedValueOnce(new Error('remove failed'));

    await expect(gitOpsService.removeWorktree('/repo/worktrees/w1', project)).rejects.toThrow(
      'remove failed'
    );
    expect(mockGitStateRemove).not.toHaveBeenCalled();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w1');
  });

  it('removeWorktree refuses requested paths that do not match the configured worktree path', async () => {
    await expect(gitOpsService.removeWorktree('/repo/other/w1', project)).rejects.toThrow(
      'Refusing to remove worktree because requested path does not match project'
    );
    expect(mockGitClient.listWorktreesWithBranches).not.toHaveBeenCalled();
    expect(mockGitClient.deleteWorktree).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('removeWorktree matches the registered worktree by full path when basenames collide', async () => {
    const collidingProject = {
      repoPath: '/repo/factory-factory',
      worktreeBasePath: '/repo/factory-factory/worktrees',
    };
    mockGitClient.getWorktreePath.mockImplementation(
      (name: string) => `/repo/factory-factory/worktrees/${name}`
    );
    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
      { path: '/repo/factory-factory' },
      { path: '/repo/factory-factory/worktrees/factory-factory' },
    ]);

    await gitOpsService.removeWorktree(
      '/repo/factory-factory/worktrees/factory-factory',
      collidingProject
    );

    expect(mockGitClient.deleteWorktree).toHaveBeenCalledWith('factory-factory');
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('ensures base branch exists unless repository is blank', async () => {
    mockGitClient.isBlankRepository.mockResolvedValueOnce(true);
    await expect(
      gitOpsService.ensureBaseBranchExists(project, 'main', 'main')
    ).resolves.toBeUndefined();

    mockGitClient.isBlankRepository.mockResolvedValueOnce(false);
    mockGitClient.branchExists.mockResolvedValueOnce(true);
    await expect(
      gitOpsService.ensureBaseBranchExists(project, 'origin/main', 'main')
    ).resolves.toBeUndefined();

    mockGitClient.isBlankRepository.mockResolvedValueOnce(false);
    mockGitClient.branchExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(
      gitOpsService.ensureBaseBranchExists(project, 'refs/heads/main', 'main')
    ).resolves.toBeUndefined();

    mockGitClient.isBlankRepository.mockResolvedValueOnce(false);
    mockGitClient.branchExists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await expect(
      gitOpsService.ensureBaseBranchExists(project, 'feature/missing', 'main')
    ).rejects.toThrow("Branch 'feature/missing' does not exist");
  });

  it('creates worktrees and checks branch checkout status', async () => {
    mockGitClient.createWorktree.mockResolvedValueOnce({ branchName: 'feature/w1' });
    mockGitClient.getWorktreePath.mockReturnValue('/repo/worktrees/w1');

    await expect(
      gitOpsService.createWorktree(project, 'w1', 'main', {
        workspaceName: 'W1',
        branchPrefix: 'pf',
      })
    ).resolves.toEqual({
      worktreePath: '/repo/worktrees/w1',
      branchName: 'feature/w1',
    });
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w1');

    mockGitClient.createWorktreeFromExistingBranch.mockResolvedValueOnce({ branchName: 'main' });
    mockGitClient.getWorktreePath.mockReturnValue('/repo/worktrees/w2');

    await expect(
      gitOpsService.createWorktreeFromExistingBranch(project, 'w2', 'origin/main')
    ).resolves.toEqual({
      worktreePath: '/repo/worktrees/w2',
      branchName: 'main',
    });
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w2');

    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
      { path: '/repo', branchName: 'main' },
      { path: '/repo/worktrees/w1', branchName: 'feature/test' },
      { path: '/tmp/external', branchName: 'feature/test' },
    ]);
    await expect(gitOpsService.isBranchCheckedOut(project, 'origin/feature/test')).resolves.toBe(
      true
    );

    mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
      { path: '/repo', branchName: 'main' },
      { path: '/repo/worktrees/w2', branchName: 'feature/other' },
    ]);
    await expect(gitOpsService.isBranchCheckedOut(project, 'feature/test')).resolves.toBe(false);
  });

  it('invalidates a partial worktree when creation fails', async () => {
    mockGitClient.createWorktree.mockRejectedValueOnce(new Error('create failed'));

    await expect(
      gitOpsService.createWorktree(project, 'w1', 'main', { workspaceName: 'W1' })
    ).rejects.toThrow('create failed');
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w1');
  });
});
