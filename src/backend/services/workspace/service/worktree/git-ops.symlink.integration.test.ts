import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/services/workspace-git-state.service', () => ({
  workspaceGitStateService: { invalidate: vi.fn(), remove: vi.fn() },
}));

import { gitOpsService } from './git-ops.service';

const execFileAsync = promisify(execFile);
let testRoot: string | undefined;

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
    testRoot = undefined;
  }
});

describe('worktree removal through a symlinked base directory', () => {
  it.each(['present', 'worktree-missing', 'base-link-missing'])(
    'clears Git registration after resolving the base: %s',
    async (missing) => {
      testRoot = await mkdtemp(path.join(tmpdir(), 'ff-worktree-symlink-'));
      const repoPath = path.join(testRoot, 'repo');
      const actualBase = path.join(testRoot, 'actual');
      const worktreeBasePath = path.join(testRoot, 'linked');
      await mkdir(repoPath);
      await mkdir(actualBase);
      await symlink(actualBase, worktreeBasePath, 'dir');
      const git = (...args: string[]) => execFileAsync('git', args, { cwd: repoPath });
      await git('init');
      await git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Initial'
      );
      const worktreePath = path.join(worktreeBasePath, 'workspace');
      await git('worktree', 'add', '-b', 'test-branch', worktreePath);
      if (missing === 'worktree-missing') {
        await rm(worktreePath, { recursive: true, force: true });
      }

      if (missing === 'base-link-missing') {
        await rm(worktreeBasePath);
        await gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath });
        expect((await git('worktree', 'list', '--porcelain')).stdout).toContain(
          'refs/heads/test-branch'
        );
        // Restoring the link recovers the identity needed for safe Git cleanup.
        await symlink(actualBase, worktreeBasePath, 'dir');
      }

      await gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath });

      expect((await git('worktree', 'list', '--porcelain')).stdout).not.toContain(
        'refs/heads/test-branch'
      );
      await expect(
        git('worktree', 'add', path.join(worktreeBasePath, 'replacement'), 'test-branch')
      ).resolves.toBeDefined();
    }
  );
});
