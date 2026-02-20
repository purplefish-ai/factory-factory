import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGitCommand = vi.hoisted(() => vi.fn());
const mockGetWorkspaceGitStats = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());

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

vi.mock('@/backend/lib/git-helpers', () => ({
  getWorkspaceGitStats: (...args: unknown[]) => mockGetWorkspaceGitStats(...args),
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

import { gitOpsService } from './git-ops.service';

const project = {
  repoPath: '/repo',
  worktreeBasePath: '/repo/worktrees',
};

describe('gitOpsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards workspace git stats helper', async () => {
    mockGetWorkspaceGitStats.mockResolvedValue({ total: 3, additions: 2, deletions: 1 });

    await expect(gitOpsService.getWorkspaceGitStats('/repo/w1', 'main')).resolves.toEqual({
      total: 3,
      additions: 2,
      deletions: 1,
    });
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
  });

  it('removeWorktree uses git when registered and fs fallback otherwise', async () => {
    mockGitClient.checkWorktreeExists.mockResolvedValueOnce(true);

    await gitOpsService.removeWorktree('/repo/worktrees/w1', project);
    expect(mockGitClient.deleteWorktree).toHaveBeenCalledWith('w1');

    mockGitClient.checkWorktreeExists.mockResolvedValueOnce(false);
    mockPathExists.mockResolvedValueOnce(true);

    await gitOpsService.removeWorktree('/repo/worktrees/w2', project);
    expect(mockRm).toHaveBeenCalledWith('/repo/worktrees/w2', { recursive: true, force: true });

    mockGitClient.checkWorktreeExists.mockResolvedValueOnce(false);
    mockPathExists.mockResolvedValueOnce(false);

    await gitOpsService.removeWorktree('/repo/worktrees/w3', project);
    expect(mockRm).toHaveBeenCalledTimes(1);
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

    mockGitClient.createWorktreeFromExistingBranch.mockResolvedValueOnce({ branchName: 'main' });
    mockGitClient.getWorktreePath.mockReturnValue('/repo/worktrees/w2');

    await expect(
      gitOpsService.createWorktreeFromExistingBranch(project, 'w2', 'origin/main')
    ).resolves.toEqual({
      worktreePath: '/repo/worktrees/w2',
      branchName: 'main',
    });

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
});
