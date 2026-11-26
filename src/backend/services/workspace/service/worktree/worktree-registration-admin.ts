import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { gitCommandC } from '@/backend/lib/shell';

/** What removing one registration did; only `removed` changed anything. */
export type RegistrationRemoval =
  | 'removed'
  | 'directory-present'
  | 'locked'
  | 'not-found'
  | 'ambiguous';

async function entryExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readGitdir(adminDir: string): Promise<string | null> {
  try {
    return (await readFile(path.join(adminDir, 'gitdir'), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Whether `dir` is a real directory (not a symlink) whose real path is
 * `expected`, so a delete inside it stays inside the Git directory.
 */
async function isRealDirectoryAt(dir: string, expected: string): Promise<boolean> {
  try {
    const stats = await lstat(dir);
    return stats.isDirectory() && !stats.isSymbolicLink() && (await realpath(dir)) === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * `<git common dir>/worktrees`, or null when the repository has none or it is
 * not a real directory inside the Git directory (a symlink is never followed).
 */
async function worktreeAdminRoot(repoPath: string): Promise<string | null> {
  const result = await gitCommandC(repoPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (result.code !== 0) {
    throw new Error(`Failed to find the Git directory: ${result.stderr || result.stdout}`);
  }
  const root = path.join(await realpath(result.stdout.trim()), 'worktrees');
  return (await isRealDirectoryAt(root, root)) ? root : null;
}

/**
 * Remove the registration of the worktree registered at `registeredPath` and
 * nothing else: the admin directory `<git common dir>/worktrees/<name>` whose
 * `gitdir` names `<registeredPath>/.git`, which is what `git worktree prune`
 * deletes for one stale entry. It never deletes at `registeredPath`, so a
 * directory that appears there at any moment survives; one present when this
 * checks keeps its registration too. A locked registration is left alone.
 */
export async function removeWorktreeRegistrationOnly(
  repoPath: string,
  registeredPath: string
): Promise<RegistrationRemoval> {
  const root = await worktreeAdminRoot(repoPath);
  if (!root) {
    return 'not-found';
  }
  const target = path.resolve(registeredPath);
  const matches: string[] = [];
  const entries: Dirent[] = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    // A symlinked admin directory is not Git's; never follow one to delete.
    if (!entry.isDirectory()) {
      continue;
    }
    const adminDir = path.join(root, entry.name);
    const gitdir = await readGitdir(adminDir);
    // Relative when `worktree.useRelativePaths` is set: relative to the admin directory.
    const worktreeGitFile = gitdir ? path.resolve(adminDir, gitdir) : null;
    if (
      worktreeGitFile &&
      path.basename(worktreeGitFile) === '.git' &&
      path.dirname(worktreeGitFile) === target
    ) {
      matches.push(adminDir);
    }
  }
  const [adminDir, ...others] = matches;
  if (!adminDir) {
    return 'not-found';
  }
  if (others.length > 0) {
    return 'ambiguous';
  }
  if (await entryExists(path.join(adminDir, 'locked'))) {
    return 'locked';
  }
  if (await entryExists(target)) {
    return 'directory-present';
  }
  // Revalidated just before deleting: neither the root nor the entry may have
  // become a symlink that would carry the delete outside the Git directory.
  if (!((await isRealDirectoryAt(root, root)) && (await isRealDirectoryAt(adminDir, adminDir)))) {
    return 'not-found';
  }
  await rm(adminDir, { recursive: true });
  return 'removed';
}
