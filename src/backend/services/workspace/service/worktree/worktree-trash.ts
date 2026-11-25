import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@/backend/lib/shell';

/**
 * Directory, directly inside a project's canonical worktree base, that holds
 * detached worktrees until the reclaimer deletes them. Being inside the base
 * keeps it on the same filesystem, so moving a worktree into it is one atomic
 * rename. It does not start with `workspace-`, so the orphan scan never sees it.
 */
export const WORKTREE_TRASH_DIR_NAME = '.ff-trash';

/** `<worktree name>.<base-36 time>-<8 hex>`; nothing else in the trash is deleted. */
const TRASH_ENTRY_PATTERN = /^[A-Za-z0-9._-]{1,100}\.[0-9a-z]{1,12}-[0-9a-f]{8}$/;

export function trashEntryName(worktreeName: string): string {
  const safeName = worktreeName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'worktree';
  return `${safeName}.${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function isTrashEntryName(name: string): boolean {
  return TRASH_ENTRY_PATTERN.test(name);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * The trash directory of a canonical base, only when it is a real directory
 * (not a symlink) whose own real path is that directory, so nothing reached
 * through it can lie outside the base. Null when it does not exist.
 */
async function verifiedTrashDir(canonicalBase: string): Promise<string | null> {
  const trashDir = path.join(canonicalBase, WORKTREE_TRASH_DIR_NAME);
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(trashDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Worktree trash is not a directory: ${trashDir}`);
  }
  if ((await fs.realpath(trashDir)) !== trashDir) {
    throw new Error(`Worktree trash is outside the worktree base: ${trashDir}`);
  }
  return trashDir;
}

/**
 * The verified trash directory of a configured worktree base, or null when the
 * base or its trash does not exist.
 */
export async function findTrashDir(worktreeBasePath: string): Promise<string | null> {
  let canonicalBase: string;
  try {
    canonicalBase = await fs.realpath(worktreeBasePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return await verifiedTrashDir(canonicalBase);
}

async function ensureTrashDir(canonicalBase: string): Promise<string> {
  try {
    await fs.mkdir(path.join(canonicalBase, WORKTREE_TRASH_DIR_NAME));
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      throw error;
    }
  }
  const trashDir = await verifiedTrashDir(canonicalBase);
  if (!trashDir) {
    throw new Error(`Worktree trash disappeared while it was created in ${canonicalBase}`);
  }
  return trashDir;
}

export type DetachResult =
  | { kind: 'moved'; trashPath: string }
  | { kind: 'deleted'; moveError: unknown };

/**
 * Take a worktree directory off its path at once: rename it into the trash of
 * its canonical base, which is atomic, so the path is either intact or gone.
 * When it cannot be moved there (another device, a trash that fails its checks,
 * no base identity), delete it in place instead, with no deadline: a deletion
 * killed part-way would leave a half-deleted worktree.
 */
export async function detachWorktreeDirectory(
  worktreePath: string,
  canonicalBase: string | null
): Promise<DetachResult> {
  let moveError: unknown = new Error('Worktree base could not be resolved');
  if (canonicalBase) {
    try {
      const trashDir = await ensureTrashDir(canonicalBase);
      const trashPath = path.join(trashDir, trashEntryName(path.basename(worktreePath)));
      await fs.rename(worktreePath, trashPath);
      return { kind: 'moved', trashPath };
    } catch (error) {
      moveError = error;
    }
  }
  await fs.rm(worktreePath, { recursive: true, force: true });
  return { kind: 'deleted', moveError };
}

/**
 * Remove a directory tree depth-first, stopping between removals once `signal`
 * aborts. Directory entries come from `readdir`, which reports a link as a link,
 * so links are unlinked and never followed.
 */
export async function removeTreeUntilAborted(
  directory: string,
  signal: AbortSignal
): Promise<void> {
  // Re-checked as each directory is opened, not trusted from its parent's
  // listing, so a directory swapped for a link or junction is never entered.
  // `directory` is a real path, so its real path must be itself.
  const stats = await fs.lstat(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error(`Refusing to descend into a link: ${directory}`);
  }
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (signal.aborted) {
      return;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeTreeUntilAborted(entryPath, signal);
    } else {
      await fs.rm(entryPath, { force: true });
    }
  }
  if (!signal.aborted) {
    await fs.rmdir(directory);
  }
}

/**
 * Delete one trash entry, with no deadline. Aborting stops the deletion; what
 * is left stays under the same entry name, so the next run resumes it.
 * Never follows symbolic links: a link is unlinked, and `rm -rf` removes links
 * inside the tree rather than their targets.
 */
export async function deleteTrashEntry(entryPath: string, signal: AbortSignal): Promise<void> {
  const stats = await fs.lstat(entryPath);
  if (!stats.isDirectory()) {
    await fs.unlink(entryPath);
    return;
  }
  if (process.platform === 'win32') {
    // No `rm` to kill on abort: walk the tree, checking the signal between removals.
    await removeTreeUntilAborted(entryPath, signal);
    return;
  }
  const result = await execCommand('rm', ['-rf', '--', entryPath], {
    timeout: 0,
    signal,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (signal.aborted) {
    return;
  }
  if (result.code !== 0) {
    throw new Error(`rm exited with ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
  }
}
