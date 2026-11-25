import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';

const mockGitCommand = vi.hoisted(() => vi.fn());
const mockGetSnapshot = vi.hoisted(() => vi.fn());
const mockGetStats = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());
const mockLstat = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockRealpath = vi.hoisted(() => vi.fn());
const mockGitStateInvalidate = vi.hoisted(() => vi.fn());
const mockGitStateRemove = vi.hoisted(() => vi.fn());

const mockDetach = vi.hoisted(() => vi.fn());
const mockWake = vi.hoisted(() => vi.fn());

const mockGitClient = vi.hoisted(() => ({
  removeWorktreeRegistration: vi.fn(),
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

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: mockWarn }),
}));

vi.mock('node:fs/promises', () => ({
  lstat: (...args: unknown[]) => mockLstat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  realpath: (...args: unknown[]) => mockRealpath(...args),
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
    withWatchersSuspended: async (worktreePath: string, operation: () => Promise<void>) => {
      mockGitStateRemove(worktreePath);
      try {
        await operation();
      } finally {
        mockGitStateRemove(worktreePath);
      }
    },
  },
}));

vi.mock('./worktree-trash', () => ({
  detachWorktreeDirectory: (...args: unknown[]) => mockDetach(...args),
}));

vi.mock('./worktree-trash-reclaimer.service', () => ({
  worktreeTrashReclaimer: { wake: mockWake },
}));

import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gitOpsService } from './git-ops.service';

const project = {
  repoPath: '/repo',
  worktreeBasePath: '/repo/worktrees',
};

describe('gitOpsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (target: string) => target);
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

  it('commitIfNeeded skips invalid repos, clean worktrees, and always commits dirty worktrees', async () => {
    mockGitCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'not a repo' });
    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1')).resolves.toBeUndefined();

    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1')).resolves.toBeUndefined();

    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '[main] Archive workspace W1', stderr: '' });

    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1')).resolves.toBeUndefined();
    expect(mockGitCommand).toHaveBeenCalledWith(['add', '-A'], '/repo/w1');
    expect(mockGitCommand).toHaveBeenCalledWith(
      ['commit', '-m', 'Archive workspace W1', '--no-verify'],
      '/repo/w1'
    );
    expect(mockGitStateInvalidate).toHaveBeenCalledOnce();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/w1');
  });

  it('classifies a failed add with the worktree index lock present', async () => {
    const addResult = {
      code: 128,
      stdout: '',
      stderr: 'fatal: Unable to create index.lock: File exists.',
    };
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce(addResult)
      .mockResolvedValueOnce({
        code: 0,
        stdout: '/repo/.git/worktrees/w1\n',
        stderr: '',
      });
    mockPathExists.mockResolvedValueOnce(true);

    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1')).rejects.toMatchObject({
      code: 'CONFLICT',
      kind: 'GIT_INDEX_LOCKED',
      message: expect.stringContaining('Git is locked'),
      cause: addResult,
    });
    expect(mockPathExists).toHaveBeenCalledWith('/repo/.git/worktrees/w1/index.lock');
  });

  it('removes only the derived worktree index lock for explicit recovery', async () => {
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '/repo/.git/worktrees/w1\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '[main] Archive workspace W1', stderr: '' });

    await expect(
      gitOpsService.commitIfNeeded('/repo/w1', 'W1', { removeGitIndexLock: true })
    ).resolves.toBeUndefined();

    expect(mockRm).toHaveBeenCalledWith('/repo/.git/worktrees/w1/index.lock', { force: true });
    expect(mockGitCommand).toHaveBeenCalledWith(['add', '-A'], '/repo/w1');
  });

  it('removes an explicitly approved lock even when the worktree became clean', async () => {
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '/repo/.git/worktrees/w1\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await expect(
      gitOpsService.commitIfNeeded('/repo/w1', 'W1', { removeGitIndexLock: true })
    ).resolves.toBeUndefined();

    expect(mockRm).toHaveBeenCalledWith('/repo/.git/worktrees/w1/index.lock', { force: true });
    expect(mockGitCommand).not.toHaveBeenCalledWith(['add', '-A'], '/repo/w1');
  });

  it('stops before status and staging when an approved lock cannot be removed', async () => {
    const removeError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '/repo/.git/worktrees/w1\n',
        stderr: '',
      });
    mockRm.mockRejectedValueOnce(removeError);

    await expect(
      gitOpsService.commitIfNeeded('/repo/w1', 'W1', { removeGitIndexLock: true })
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Failed to remove Git index lock',
      cause: removeError,
    });
    expect(mockGitCommand).toHaveBeenCalledTimes(2);
  });

  it('invalidates staged archive changes when the commit fails', async () => {
    const commitResult = { code: 1, stdout: '', stderr: 'commit failed' };
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(commitResult)
      .mockResolvedValueOnce({
        code: 0,
        stdout: '/repo/.git/worktrees/w1\n',
        stderr: '',
      });
    mockPathExists.mockResolvedValueOnce(false);

    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Git commit failed',
      cause: commitResult,
    });
    expect(mockGitStateInvalidate).toHaveBeenCalledOnce();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/w1');
  });

  it('classifies a failed commit with the worktree index lock present', async () => {
    const commitResult = {
      code: 128,
      stdout: '',
      stderr: 'fatal: Unable to create index.lock: File exists.',
    };
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: ' M file.ts\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(commitResult)
      .mockResolvedValueOnce({
        code: 0,
        stdout: '/repo/.git/worktrees/w1\n',
        stderr: '',
      });
    mockPathExists.mockResolvedValueOnce(true);

    await expect(gitOpsService.commitIfNeeded('/repo/w1', 'W1')).rejects.toMatchObject({
      code: 'CONFLICT',
      kind: 'GIT_INDEX_LOCKED',
      message: expect.stringContaining('Git is locked'),
      cause: commitResult,
    });
    expect(mockPathExists).toHaveBeenCalledWith('/repo/.git/worktrees/w1/index.lock');
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/w1');
  });

  it('sanitizes git command failures while retaining the raw result as the cause', async () => {
    const statusResult = {
      code: 1,
      stdout: 'status stdout SECRET_STDERR_TOKEN',
      stderr: 'status stderr SECRET_STDERR_TOKEN',
    };
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git', stderr: '' })
      .mockResolvedValueOnce(statusResult);

    const error = await gitOpsService
      .commitIfNeeded('/repo/w1', 'W1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Git status failed',
      cause: statusResult,
    });
    expect((error as Error).message).not.toContain('SECRET_STDERR_TOKEN');
  });

  describe('removeWorktree', () => {
    let onDisk: Set<string>;

    beforeEach(() => {
      onDisk = new Set();
      mockLstat.mockImplementation((target: string) =>
        onDisk.has(target)
          ? Promise.resolve({ isSymbolicLink: () => false, isDirectory: () => true })
          : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      );
      mockDetach.mockImplementation((target: string) => {
        onDisk.delete(target);
        return Promise.resolve({ kind: 'moved', trashPath: `/repo/worktrees/.ff-trash/${target}` });
      });
      mockGitClient.removeWorktreeRegistration.mockResolvedValue(undefined);
    });

    it('moves the directory to the trash, then removes its registration', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1' },
      ]);

      await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

      expect(mockDetach).toHaveBeenCalledWith('/repo/worktrees/w1', '/repo/worktrees');
      expect(mockGitClient.removeWorktreeRegistration).toHaveBeenCalledWith('/repo/worktrees/w1');
      expect(mockDetach.mock.invocationCallOrder[0]).toBeLessThan(
        mockGitClient.removeWorktreeRegistration.mock.invocationCallOrder[0]!
      );
      expect(mockWake).toHaveBeenCalledOnce();
    });

    it('moves an unregistered directory without Git, and does nothing when both are gone', async () => {
      onDisk.add('/repo/worktrees/w2');
      mockGitClient.listWorktreesWithBranches.mockResolvedValue([]);

      await gitOpsService.removeWorktree('/repo/worktrees/w2', project);
      expect(mockDetach).toHaveBeenCalledWith('/repo/worktrees/w2', '/repo/worktrees');

      await gitOpsService.removeWorktree('/repo/worktrees/w3', project);
      expect(mockDetach).toHaveBeenCalledTimes(1);
      expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
      expect(mockGitStateRemove).toHaveBeenLastCalledWith('/repo/worktrees/w3');
    });

    it('converges on retry: a moved directory leaves only the registration to remove', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockGitClient.listWorktreesWithBranches.mockResolvedValue([{ path: '/repo/worktrees/w1' }]);
      mockGitClient.removeWorktreeRegistration.mockRejectedValueOnce(new Error('git failed'));

      await expect(gitOpsService.removeWorktree('/repo/worktrees/w1', project)).rejects.toThrow(
        'git failed'
      );
      expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w1');

      await gitOpsService.removeWorktree('/repo/worktrees/w1', project);
      expect(mockDetach).toHaveBeenCalledTimes(1);
      expect(mockGitClient.removeWorktreeRegistration).toHaveBeenCalledTimes(2);
    });

    it('never lets Git delete a registered directory that is still present', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockDetach.mockResolvedValueOnce({ kind: 'moved', trashPath: '/elsewhere' });
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1' },
      ]);

      await expect(gitOpsService.removeWorktree('/repo/worktrees/w1', project)).rejects.toThrow(
        'directory remains'
      );
      expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
    });

    it('refuses a locked worktree before moving anything', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1', locked: true },
      ]);

      await expect(gitOpsService.removeWorktree('/repo/worktrees/w1', project)).rejects.toThrow(
        'locked'
      );
      expect(mockDetach).not.toHaveBeenCalled();
      expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
    });

    it('logs an in-place deletion and does not wake the reclaimer', async () => {
      onDisk.add('/repo/worktrees/w1');
      const moveError = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      mockDetach.mockImplementationOnce((target: string) => {
        onDisk.delete(target);
        return Promise.resolve({ kind: 'deleted', moveError });
      });
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1' },
      ]);

      await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('in place'),
        expect.objectContaining({ worktreePath: '/repo/worktrees/w1', error: 'cross-device' })
      );
      expect(mockWake).not.toHaveBeenCalled();
      expect(mockGitClient.removeWorktreeRegistration).toHaveBeenCalledWith('/repo/worktrees/w1');
    });

    it('suspends Git state watchers around the move and the registration removal', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1' },
      ]);

      await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

      expect(mockGitStateRemove).toHaveBeenCalledTimes(2);
      expect(mockGitStateRemove).toHaveBeenCalledWith('/repo/worktrees/w1');
      expect(mockGitStateRemove.mock.invocationCallOrder[0]).toBeLessThan(
        mockDetach.mock.invocationCallOrder[0]!
      );
      expect(mockGitStateRemove.mock.invocationCallOrder[1]).toBeGreaterThan(
        mockGitClient.removeWorktreeRegistration.mock.invocationCallOrder[0]!
      );
    });

    it('allows lazy watcher recovery when the move fails', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([]);
      mockDetach.mockRejectedValueOnce(new Error('filesystem removal failed'));

      await expect(gitOpsService.removeWorktree('/repo/worktrees/w1', project)).rejects.toThrow(
        'filesystem removal failed'
      );
      expect(mockGitStateRemove).toHaveBeenCalledWith('/repo/worktrees/w1');
      expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w1');
    });

    it('checks the init guard before any destructive step', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1' },
      ]);
      const guard = {
        check: vi.fn(async () => undefined),
        assertCurrent: vi.fn(() => {
          throw new Error('superseded');
        }),
      };

      await expect(
        gitOpsService.removeWorktree('/repo/worktrees/w1', project, unsafeCoerce(guard))
      ).rejects.toThrow('superseded');
      expect(mockDetach).not.toHaveBeenCalled();
      expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
    });

    it('refuses requested paths that do not match the configured worktree path', async () => {
      await expect(gitOpsService.removeWorktree('/repo/other/w1', project)).rejects.toThrow(
        'Refusing to remove worktree because requested path does not match project'
      );
      expect(mockGitClient.listWorktreesWithBranches).not.toHaveBeenCalled();
      expect(mockDetach).not.toHaveBeenCalled();
    });

    it('warns without guessing a registration when the base link no longer resolves', async () => {
      mockRealpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/canonical/worktrees/w1' },
        { path: '/another/worktrees/w1' },
      ]);

      await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('worktree base'),
        expect.objectContaining({ worktreePath: '/repo/worktrees/w1' })
      );
      expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
      expect(mockDetach).not.toHaveBeenCalled();
    });

    it('removes a registration at the configured path when the base is already missing', async () => {
      mockRealpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      mockGitClient.listWorktreesWithBranches.mockResolvedValueOnce([
        { path: '/repo/worktrees/w1', branch: 'w1' },
      ]);

      await gitOpsService.removeWorktree('/repo/worktrees/w1', project);

      expect(mockGitClient.removeWorktreeRegistration).toHaveBeenCalledWith('/repo/worktrees/w1');
      expect(mockDetach).not.toHaveBeenCalled();
    });

    it('does not touch files when canonical path lookup fails', async () => {
      onDisk.add('/repo/worktrees/w1');
      mockRealpath.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(gitOpsService.removeWorktree('/repo/worktrees/w1', project)).rejects.toThrow(
        'denied'
      );

      expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
      expect(mockDetach).not.toHaveBeenCalled();
    });

    it('matches the registered worktree by full path when basenames collide', async () => {
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

      expect(mockGitClient.removeWorktreeRegistration).toHaveBeenCalledWith(
        '/repo/factory-factory/worktrees/factory-factory'
      );
      expect(mockGitClient.removeWorktreeRegistration).toHaveBeenCalledTimes(1);
    });
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

  it('recognizes a branch under a symlinked worktree base', async () => {
    mockRealpath.mockImplementation(async (target: string) =>
      target === '/repo/worktrees' ? '/actual/worktrees' : target
    );
    mockGitClient.listWorktreesWithBranches.mockResolvedValue([
      { path: '/actual/worktrees/w1', branchName: 'feature/test' },
    ]);
    await expect(gitOpsService.isBranchCheckedOut(project, 'origin/feature/test')).resolves.toBe(
      true
    );
    await expect(gitOpsService.isBranchCheckedOut(project, 'feature/other')).resolves.toBe(false);
  });

  it('matches the configured base when it no longer resolves', async () => {
    mockRealpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mockGitClient.listWorktreesWithBranches.mockResolvedValue([
      { path: '/repo/worktrees/w1', branchName: 'feature/test' },
    ]);
    await expect(gitOpsService.isBranchCheckedOut(project, 'feature/test')).resolves.toBe(true);
  });

  it('invalidates a partial worktree when creation fails', async () => {
    mockGitClient.createWorktree.mockRejectedValueOnce(new Error('create failed'));

    await expect(
      gitOpsService.createWorktree(project, 'w1', 'main', { workspaceName: 'W1' })
    ).rejects.toThrow('create failed');
    expect(mockGitStateInvalidate).toHaveBeenCalledWith('/repo/worktrees/w1');
  });
});

describe('event creation candidate ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    mockRealpath.mockResolvedValue('/real/worktrees');
    mockGitClient.getWorktreePath.mockReturnValue('/repo/worktrees/w1');
    mockGitClient.listWorktreesWithBranches.mockResolvedValue([]);
  });
  it('returns the deterministic candidate only after checking disk and canonical Git registry', async () => {
    await expect(gitOpsService.prepareWorktreeCreation(project, 'w1')).resolves.toEqual({
      worktreePath: '/repo/worktrees/w1',
      canonicalBasePath: '/real/worktrees',
    });
    expect(mockLstat).toHaveBeenCalledWith('/repo/worktrees/w1');
    expect(mockGitClient.listWorktreesWithBranches).toHaveBeenCalledOnce();
  });
  it('preserves existing directories and broken symlinks by refusing any lstat entry', async () => {
    mockLstat.mockResolvedValue({ isSymbolicLink: () => true });
    await expect(gitOpsService.prepareWorktreeCreation(project, 'w1')).rejects.toThrow(
      'preexisting'
    );
    expect(mockGitClient.createWorktree).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });
  it('preserves a registered worktree whose physical path is missing', async () => {
    mockGitClient.listWorktreesWithBranches.mockResolvedValue([{ path: '/real/worktrees/w1' }]);
    await expect(gitOpsService.prepareWorktreeCreation(project, 'w1')).rejects.toThrow('retained');
    expect(mockGitClient.removeWorktreeRegistration).not.toHaveBeenCalled();
  });
  it('does not interpret inspection errors as absence', async () => {
    mockLstat.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(gitOpsService.prepareWorktreeCreation(project, 'w1')).rejects.toThrow('denied');
    expect(mockGitClient.listWorktreesWithBranches).not.toHaveBeenCalled();
  });
  it('proves absence only when both disk and canonical Git registration are absent', async () => {
    await expect(
      gitOpsService.confirmWorktreeAbsent('/repo/worktrees/w1', project, '/real/worktrees')
    ).resolves.toBe(true);
    expect(mockLstat).toHaveBeenCalled();
    expect(mockGitClient.listWorktreesWithBranches).toHaveBeenCalled();
    mockGitClient.listWorktreesWithBranches.mockResolvedValue([{ path: '/real/worktrees/w1' }]);
    await expect(
      gitOpsService.confirmWorktreeAbsent('/repo/worktrees/w1', project, '/real/worktrees')
    ).resolves.toBe(false);
  });
  it('refuses absence proof when the canonical base changes or cannot be inspected', async () => {
    mockRealpath.mockResolvedValue('/different-base');
    await expect(
      gitOpsService.confirmWorktreeAbsent('/repo/worktrees/w1', project, '/real/worktrees')
    ).rejects.toThrow('identity changed');
    mockRealpath.mockRejectedValue(Object.assign(new Error('base missing'), { code: 'ENOENT' }));
    await expect(
      gitOpsService.confirmWorktreeAbsent('/repo/worktrees/w1', project, '/real/worktrees')
    ).rejects.toThrow('base missing');
    expect(mockGitClient.listWorktreesWithBranches).not.toHaveBeenCalled();
  });
  it('refuses absence proof if Git registrations cannot be inspected', async () => {
    mockGitClient.listWorktreesWithBranches.mockRejectedValue(new Error('Git unavailable'));
    await expect(
      gitOpsService.confirmWorktreeAbsent('/repo/worktrees/w1', project, '/real/worktrees')
    ).rejects.toThrow('Git unavailable');
  });

  describe('adversarial review checkout helpers', () => {
    const SHA = 'a'.repeat(40);
    const OTHER_SHA = 'b'.repeat(40);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const fail = (stderr = 'fatal') => ({ code: 128, stdout: '', stderr });

    it('reads branch, HEAD, changes and GitHub origin from one status snapshot', async () => {
      mockGitCommand
        .mockResolvedValueOnce(
          ok(`# branch.oid ${SHA}\n# branch.head feature/x\n# branch.upstream origin/feature/x\n`)
        )
        .mockResolvedValueOnce(ok('git@github.com:example/repo.git\n'));

      await expect(gitOpsService.getCheckoutIdentity('/repo/w1')).resolves.toEqual({
        branch: 'feature/x',
        headSha: SHA,
        hasLocalChanges: false,
        origin: { owner: 'example', repo: 'repo' },
      });
      expect(mockGitCommand).toHaveBeenCalledTimes(2);
      expect(mockGitCommand).toHaveBeenCalledWith(
        ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
        '/repo/w1'
      );
      expect(mockGitCommand).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repo/w1');
    });

    it.each([
      ['modified', '1 .M N... 100644 100644 100644 aaa bbb src/a.ts'],
      ['untracked', '? notes.txt'],
    ])('reports %s files as local changes', async (_name, entry) => {
      mockGitCommand
        .mockResolvedValueOnce(ok(`# branch.oid ${SHA}\n# branch.head feature/x\n${entry}\n`))
        .mockResolvedValueOnce(ok('https://github.com/example/repo\n'));

      await expect(gitOpsService.getCheckoutIdentity('/repo/w1')).resolves.toMatchObject({
        hasLocalChanges: true,
      });
    });

    it('reports a detached HEAD as a null branch with its commit', async () => {
      mockGitCommand
        .mockResolvedValueOnce(ok(`# branch.oid ${SHA}\n# branch.head (detached)\n`))
        .mockResolvedValueOnce(ok('git@github.com:example/repo.git\n'));

      await expect(gitOpsService.getCheckoutIdentity('/repo/w1')).resolves.toEqual({
        branch: null,
        headSha: SHA,
        hasLocalChanges: false,
        origin: { owner: 'example', repo: 'repo' },
      });
    });

    it('reports an unborn branch with no commit and a missing origin', async () => {
      mockGitCommand
        .mockResolvedValueOnce(ok('# branch.oid (initial)\n# branch.head main\n'))
        .mockResolvedValueOnce(fail('No such remote'));

      await expect(gitOpsService.getCheckoutIdentity('/repo/w1')).resolves.toEqual({
        branch: 'main',
        headSha: null,
        hasLocalChanges: false,
        origin: null,
      });
    });

    it('reports every field as unknown when git status fails', async () => {
      mockGitCommand.mockResolvedValueOnce(fail()).mockResolvedValueOnce(fail());

      await expect(gitOpsService.getCheckoutIdentity('/repo/w1')).resolves.toEqual({
        branch: null,
        headSha: null,
        hasLocalChanges: null,
        origin: null,
      });
    });

    it('checks ancestry and commit presence without throwing on missing objects', async () => {
      mockGitCommand.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail());
      await expect(gitOpsService.isAncestorCommit('/repo/w1', SHA, OTHER_SHA)).resolves.toBe(true);
      await expect(gitOpsService.isAncestorCommit('/repo/w1', SHA, OTHER_SHA)).resolves.toBe(false);
      expect(mockGitCommand).toHaveBeenCalledWith(
        ['merge-base', '--is-ancestor', SHA, OTHER_SHA],
        '/repo/w1'
      );

      mockGitCommand.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail());
      await expect(gitOpsService.hasCommit('/repo/w1', SHA)).resolves.toBe(true);
      await expect(gitOpsService.hasCommit('/repo/w1', SHA)).resolves.toBe(false);
      expect(mockGitCommand).toHaveBeenCalledWith(
        ['cat-file', '-e', `${SHA}^{commit}`],
        '/repo/w1'
      );
    });

    it('refuses to pass non-SHA revisions to Git', async () => {
      await expect(gitOpsService.hasCommit('/repo/w1', '--output=/tmp/x')).rejects.toThrow(
        'Invalid commit SHA'
      );
      await expect(gitOpsService.isAncestorCommit('/repo/w1', SHA, 'HEAD')).rejects.toThrow(
        'Invalid commit SHA'
      );
      expect(mockGitCommand).not.toHaveBeenCalled();
    });

    it('fetches a PR head into a private ref without writing FETCH_HEAD', async () => {
      mockGitCommand.mockResolvedValueOnce(ok());

      await gitOpsService.fetchPullRequestHead('/repo/w1', 42, 'refs/factory-factory/review/pr-1');

      expect(mockGitCommand).toHaveBeenCalledWith(
        [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          'origin',
          '+refs/pull/42/head:refs/factory-factory/review/pr-1',
        ],
        '/repo/w1'
      );
    });

    it('reports fetch failures with Git output', async () => {
      mockGitCommand.mockResolvedValueOnce(fail('fatal: could not read Username'));

      await expect(
        gitOpsService.fetchPullRequestHead('/repo/w1', 42, 'refs/factory-factory/review/pr-1')
      ).rejects.toThrow('Failed to fetch pull request head: fatal: could not read Username');
    });

    it.each(['refs/heads/main', 'refs/factory-factory/../heads/main', 'refs/factory-factory/a b'])(
      'refuses to write or delete the non-private ref %s',
      async (ref) => {
        await expect(gitOpsService.fetchPullRequestHead('/repo/w1', 42, ref)).rejects.toThrow(
          'non-private ref'
        );
        await expect(gitOpsService.deletePrivateRef('/repo/w1', ref)).rejects.toThrow(
          'non-private ref'
        );
        expect(mockGitCommand).not.toHaveBeenCalled();
      }
    );

    it('rejects invalid PR numbers before fetching', async () => {
      await expect(
        gitOpsService.fetchPullRequestHead('/repo/w1', 0, 'refs/factory-factory/review/pr-1')
      ).rejects.toThrow('Invalid pull request number');
      expect(mockGitCommand).not.toHaveBeenCalled();
    });

    it('deletes a private ref', async () => {
      mockGitCommand.mockResolvedValueOnce(ok());

      await gitOpsService.deletePrivateRef('/repo/w1', 'refs/factory-factory/review/pr-1');

      expect(mockGitCommand).toHaveBeenCalledWith(
        ['update-ref', '-d', 'refs/factory-factory/review/pr-1'],
        '/repo/w1'
      );
    });
  });
});
