import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A path this file's `lstat` reports missing although it exists: the directory
// reappears just after the last check that could have seen it.
const race = vi.hoisted(() => ({ hiddenPath: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: (target: string, ...rest: []) =>
      target === race.hiddenPath
        ? Promise.reject(Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' }))
        : actual.lstat(target, ...rest),
  };
});

import { removeWorktreeRegistrationOnly } from './worktree-registration-admin';

const execFileAsync = promisify(execFile);
let testRoot: string;
let repoPath: string;

const git = async (...args: string[]) =>
  (await execFileAsync('git', args, { cwd: repoPath })).stdout;

beforeEach(async () => {
  testRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ff-registration-race-')));
  repoPath = path.join(testRoot, 'repo');
  await mkdir(repoPath);
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
});

afterEach(async () => {
  race.hiddenPath = null;
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

it('keeps a worktree directory that reappears after the absence check', async () => {
  const worktree = path.join(testRoot, 'worktrees', 'workspace-race');
  await git('worktree', 'add', '--detach', worktree);
  await rm(worktree, { recursive: true, force: true });
  // Back again, with work in it, after the removal has decided it is gone.
  await mkdir(worktree);
  await writeFile(path.join(worktree, 'uncommitted.txt'), 'came back');
  race.hiddenPath = worktree;

  await expect(removeWorktreeRegistrationOnly(repoPath, worktree)).resolves.toBe('removed');

  expect(await readFile(path.join(worktree, 'uncommitted.txt'), 'utf8')).toBe('came back');
  expect(await readdir(path.join(repoPath, '.git', 'worktrees'))).toEqual([]);
});
