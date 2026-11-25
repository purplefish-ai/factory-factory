import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '@/backend/clients/git.client';
import { JobRunner } from '@/backend/services/job-runner.service';
import { gitOpsService } from './git-ops.service';
import { WORKTREE_TRASH_DIR_NAME } from './worktree-trash';
import { WorktreeTrashReclaimer } from './worktree-trash-reclaimer.service';

const execFileAsync = promisify(execFile);
let testRoot: string;
let repoPath: string;
let worktreeBasePath: string;
let worktreePath: string;

const git = async (...args: string[]) =>
  (await execFileAsync('git', args, { cwd: repoPath })).stdout;

beforeEach(async () => {
  testRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ff-worktree-trash-')));
  repoPath = path.join(testRoot, 'repo');
  worktreeBasePath = path.join(testRoot, 'worktrees');
  await mkdir(repoPath);
  await mkdir(worktreeBasePath);
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
  worktreePath = path.join(worktreeBasePath, 'workspace-trash');
  await git('worktree', 'add', '-b', 'trash-branch', worktreePath);
  await mkdir(path.join(worktreePath, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(worktreePath, 'node_modules', 'pkg', 'index.js'), 'x');
  await writeFile(path.join(worktreePath, 'notes.txt'), 'kept until reclaimed');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

async function trashEntries(): Promise<string[]> {
  return await readdir(path.join(worktreeBasePath, WORKTREE_TRASH_DIR_NAME));
}

describe('worktree removal detaches, then reclaims', () => {
  it('moves the worktree to the trash, drops its registration and keeps the branch', async () => {
    await gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath });

    await expect(lstat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git('worktree', 'list', '--porcelain')).not.toContain(worktreePath);
    expect(await git('branch', '--list', 'trash-branch')).toContain('trash-branch');
    const [entry, ...rest] = await trashEntries();
    expect(rest).toEqual([]);
    expect(
      await readFile(
        path.join(worktreeBasePath, WORKTREE_TRASH_DIR_NAME, entry!, 'notes.txt'),
        'utf8'
      )
    ).toBe('kept until reclaimed');

    await new WorktreeTrashReclaimer(
      { listWorktreeBasePaths: async () => [worktreeBasePath] },
      new JobRunner()
    ).run(new AbortController().signal);
    expect(await trashEntries()).toEqual([]);
    await expect(
      git('worktree', 'add', path.join(worktreeBasePath, 'again'), 'trash-branch')
    ).resolves.toBeDefined();
  });

  it('converges on retry after the Git step fails once the directory has moved', async () => {
    vi.spyOn(GitClient.prototype, 'removeWorktreeRegistration').mockRejectedValueOnce(
      new Error('git unavailable')
    );

    await expect(
      gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath })
    ).rejects.toThrow('git unavailable');
    await expect(lstat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git('worktree', 'list', '--porcelain')).toContain(worktreePath);

    await gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath });

    expect(await git('worktree', 'list', '--porcelain')).not.toContain(worktreePath);
    expect(await trashEntries()).toHaveLength(1);
    await expect(
      gitOpsService.prepareWorktreeCreation({ repoPath, worktreeBasePath }, 'workspace-trash')
    ).resolves.toMatchObject({ worktreePath });
  });

  it('leaves a locked worktree in place', async () => {
    await git('worktree', 'lock', worktreePath);

    await expect(
      gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath })
    ).rejects.toThrow('locked');

    expect(await readFile(path.join(worktreePath, 'notes.txt'), 'utf8')).toBe(
      'kept until reclaimed'
    );
    expect(await git('worktree', 'list', '--porcelain')).toContain(worktreePath);
  });

  it('never prunes registrations it does not own', async () => {
    const foreign = path.join(testRoot, 'foreign-checkout');
    await git('worktree', 'add', '-b', 'foreign-branch', foreign);
    await rm(foreign, { recursive: true, force: true });

    await gitOpsService.removeWorktree(worktreePath, { repoPath, worktreeBasePath });

    expect(await git('worktree', 'list', '--porcelain')).toContain(foreign);
  });
});
