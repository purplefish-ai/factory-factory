import { readdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@/backend/lib/shell';
import { APP_PRIVATE_REF_PREFIX, assertAppPrivateRef } from './git-ops.service';

/**
 * Git reads and the pinned, compare-and-swap deletion behind the archived-branch
 * cleanup. Every read fails loudly so the caller skips the repository instead
 * of treating an unanswered question as "safe to delete".
 */

export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEADS_PREFIX = 'refs/heads/';
/** Pins live under `refs/factory-factory/deleted-branches/<encoded name>/<sha>`. */
export const DELETED_BRANCH_PIN_PREFIX = `${APP_PRIVATE_REF_PREFIX}deleted-branches/`;
/** Keeps each `rev-list` argument list well under the OS limit. */
const REV_LIST_CHUNK = 200;
const REV_LIST_MAX_BUFFER = 64 * 1024 * 1024;

export interface LocalBranch {
  name: string;
  sha: string;
}

export async function git(repoPath: string, args: string[], maxBuffer?: number): Promise<string> {
  const result = await execCommand('git', ['-C', repoPath, ...args], {
    ...(maxBuffer && { maxBuffer }),
  });
  if (result.code !== 0 || result.maxBufferExceeded || result.timedOut) {
    throw new Error(
      `git ${args[0]} failed in ${repoPath}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`
    );
  }
  return result.stdout;
}

/** The repository's shared Git directory, resolved, so projects sharing a repository group together. */
export async function resolveRepositoryIdentity(repoPath: string): Promise<string> {
  const commonDir = (
    await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  return realpath(commonDir);
}

/** Local branches that point directly at a commit; symbolic branches are left out. */
export async function listLocalBranches(repoPath: string): Promise<LocalBranch[]> {
  const stdout = await git(repoPath, [
    'for-each-ref',
    '--format=%(objecttype)%00%(objectname)%00%(symref)%00%(refname)',
    HEADS_PREFIX,
  ]);
  return stdout.split('\n').flatMap((line) => {
    const [type, sha, symref, refname] = line.split('\0');
    if (
      type !== 'commit' ||
      !sha ||
      !COMMIT_SHA.test(sha) ||
      symref ||
      !refname?.startsWith(HEADS_PREFIX)
    ) {
      return [];
    }
    return [{ name: refname.slice(HEADS_PREFIX.length), sha }];
  });
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function linkedWorktreeGitDirs(commonDir: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(commonDir, 'worktrees'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(commonDir, 'worktrees', entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Branches that are checked out in any registered worktree of the repository
 * (the main checkout, app worktrees and worktrees other tools created, even
 * when their folder is missing), or that a rebase or bisect in any worktree
 * will return to. These are the same checks `git branch -d` makes.
 */
export async function listBusyBranches(repoPath: string): Promise<Set<string>> {
  const busy = new Set<string>();
  const addRef = (value: string | null) => {
    if (value?.startsWith(HEADS_PREFIX)) {
      busy.add(value.slice(HEADS_PREFIX.length));
    }
  };

  const porcelain = await git(repoPath, ['worktree', 'list', '--porcelain', '-z']);
  for (const field of porcelain.split('\0')) {
    if (field.startsWith('branch ')) {
      addRef(field.slice('branch '.length));
    }
  }

  const commonDir = await resolveRepositoryIdentity(repoPath);
  for (const gitDir of [commonDir, ...(await linkedWorktreeGitDirs(commonDir))]) {
    addRef(await readOptional(path.join(gitDir, 'rebase-merge', 'head-name')));
    addRef(await readOptional(path.join(gitDir, 'rebase-apply', 'head-name')));
    // BISECT_START holds the branch `git bisect reset` returns to, by short name.
    const bisectStart = await readOptional(path.join(gitDir, 'BISECT_START'));
    if (bisectStart) {
      busy.add(
        bisectStart.startsWith(HEADS_PREFIX) ? bisectStart.slice(HEADS_PREFIX.length) : bisectStart
      );
    }
  }
  return busy;
}

/** The subset of `shas` reachable from any remote-tracking ref. */
export async function findCommitsOnRemotes(repoPath: string, shas: string[]): Promise<Set<string>> {
  const unique = [...new Set(shas)].filter((sha) => COMMIT_SHA.test(sha));
  const hasRemoteRefs = (
    await git(repoPath, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/'])
  ).trim();
  if (unique.length === 0 || !hasRemoteRefs) {
    return new Set();
  }
  // Listing what the tips reach that no remote does keeps the output to
  // unpushed commits only; a tip missing from that list is on a remote.
  const notOnRemotes = new Set<string>();
  for (let start = 0; start < unique.length; start += REV_LIST_CHUNK) {
    const chunk = unique.slice(start, start + REV_LIST_CHUNK);
    const stdout = await git(
      repoPath,
      ['rev-list', ...chunk, '--not', '--remotes'],
      REV_LIST_MAX_BUFFER
    );
    for (const line of stdout.split('\n')) {
      if (line) {
        notOnRemotes.add(line.trim());
      }
    }
  }
  return new Set(unique.filter((sha) => !notOnRemotes.has(sha)));
}

/**
 * Encode a branch name into one ref component of `[A-Za-z0-9-]` plus `_XX`
 * escapes. `_` is itself escaped, so distinct names never share a pin.
 */
export function encodeBranchForRef(name: string): string {
  let encoded = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9-]/.test(char)
      ? char
      : `_${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** The app-private ref that keeps a deleted branch's tip reachable. */
export function deletedBranchPinRef(name: string, sha: string): string {
  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`Invalid commit SHA: ${sha}`);
  }
  const ref = `${DELETED_BRANCH_PIN_PREFIX}${encodeBranchForRef(name)}/${sha}`;
  assertAppPrivateRef(ref);
  return ref;
}

export type BranchDeletionOutcome =
  | { status: 'removed'; pinRef: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export async function readRefSha(repoPath: string, ref: string): Promise<string | null> {
  const result = await execCommand('git', [
    '-C',
    repoPath,
    'rev-parse',
    '--verify',
    '--quiet',
    ref,
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * True when `ancestor` is `descendant` or reachable from it. False when Git
 * says no or cannot answer, for example because `descendant` was never fetched.
 */
export async function isSameOrAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  if (!(COMMIT_SHA.test(ancestor) && COMMIT_SHA.test(descendant))) {
    return false;
  }
  if (ancestor === descendant) {
    return true;
  }
  const result = await execCommand('git', [
    '-C',
    repoPath,
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ]);
  return result.code === 0;
}

/**
 * Recreate a branch that was just deleted, at its old tip, only if nothing has
 * created it again since.
 */
export async function restoreDeletedBranch(
  repoPath: string,
  name: string,
  sha: string
): Promise<boolean> {
  const result = await execCommand('git', [
    '-C',
    repoPath,
    'update-ref',
    '--no-deref',
    '-m',
    'factory-factory: restore branch that came into use during deletion',
    `${HEADS_PREFIX}${name}`,
    sha,
    '0'.repeat(sha.length),
  ]);
  return result.code === 0;
}

/**
 * Pin the branch tip under an app-private ref, then delete the branch only if
 * it still points at `expectedSha`. A branch that moved or vanished is left
 * alone. Remote branches are never touched.
 */
export async function pinAndDeleteBranch(
  repoPath: string,
  name: string,
  expectedSha: string
): Promise<BranchDeletionOutcome> {
  const pinRef = deletedBranchPinRef(name, expectedSha);
  const branchRef = `${HEADS_PREFIX}${name}`;
  // Create the pin only if it is absent, so this call knows whether it owns
  // it; an earlier deletion at the same commit may already rely on it.
  const pin = await execCommand('git', [
    '-C',
    repoPath,
    'update-ref',
    '-m',
    `factory-factory: pin before deleting ${branchRef}`,
    pinRef,
    expectedSha,
    '0'.repeat(expectedSha.length),
  ]);
  const createdPin = pin.code === 0;
  if (!(createdPin || (await readRefSha(repoPath, pinRef)) === expectedSha)) {
    return { status: 'failed', error: `Could not pin the branch tip: ${pin.stderr.trim()}` };
  }
  const deletion = await execCommand('git', [
    '-C',
    repoPath,
    'update-ref',
    '--no-deref',
    '-d',
    branchRef,
    expectedSha,
  ]);
  if (deletion.code === 0) {
    return { status: 'removed', pinRef };
  }
  const current = await readRefSha(repoPath, branchRef);
  if (current === expectedSha) {
    return { status: 'failed', error: deletion.stderr.trim() || `exit ${deletion.code}` };
  }
  // Remove a pin this call created only while the branch still exists at
  // another commit. When the branch is gone, someone else may have deleted it
  // relying on this pin, so it stays; a leftover pin only keeps a commit
  // reachable.
  if (createdPin && current !== null) {
    await execCommand('git', ['-C', repoPath, 'update-ref', '-d', pinRef, expectedSha]);
  }
  return current === null
    ? { status: 'skipped', reason: 'Branch no longer exists' }
    : { status: 'skipped', reason: 'Branch moved since it was listed' };
}
