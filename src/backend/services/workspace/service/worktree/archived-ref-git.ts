import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { execCommand } from '@/backend/lib/shell';
import {
  COMMIT_SHA,
  DELETED_BRANCH_PIN_PREFIX,
  encodeBranchForRef,
  git,
  readRefSha,
} from './archived-branch-git';
import { APP_PRIVATE_REF_PREFIX, assertAppPrivateRef } from './git-ops.service';

/**
 * Git reads and the compare-and-swap deletion behind the archived-ref cleanup.
 * Only two ref families are ever read or deleted here: archive snapshots and
 * deleted-branch pins. Every read fails loudly so the caller skips the
 * repository instead of treating an unanswered question as "safe to delete".
 */

export const ARCHIVE_REF_PREFIX = `${APP_PRIVATE_REF_PREFIX}archive/`;
/** `refs/factory-factory/archive/<workspace id>`. */
const ARCHIVE_REF = /^refs\/factory-factory\/archive\/([A-Za-z0-9_-]+)$/;
/** `refs/factory-factory/deleted-branches/<encoded branch name>/<commit>`. */
const DELETED_BRANCH_PIN =
  /^refs\/factory-factory\/deleted-branches\/([A-Za-z0-9_-]+)\/([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;
/** Shas per `rev-list` call; keeps each argument list near 20 KB. */
const REV_LIST_CHUNK = 500;
const REV_LIST_MAX_BUFFER = 64 * 1024 * 1024;

export type ArchivedRefKind = 'ARCHIVE' | 'DELETED_BRANCH';

export interface ArchivedRef {
  ref: string;
  sha: string;
  kind: ArchivedRefKind;
  /** The archived workspace's id, for an archive ref. */
  workspaceId: string | null;
  /** The deleted branch's name, for a pin. */
  branchName: string | null;
  committedAt: Date;
}

/** The workspace id an archive ref is named after, or null for any other ref. */
export function archiveRefWorkspaceId(ref: string): string | null {
  return ARCHIVE_REF.exec(ref)?.[1] ?? null;
}

/** Reverse `encodeBranchForRef`; null when the component is not one it produced. */
export function decodeBranchFromRef(encoded: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const char = encoded.charAt(i);
    if (char !== '_') {
      if (!/[A-Za-z0-9-]/.test(char)) {
        return null;
      }
      bytes.push(char.charCodeAt(0));
      continue;
    }
    const hex = encoded.slice(i + 1, i + 3);
    if (!/^[0-9A-F]{2}$/.test(hex)) {
      return null;
    }
    bytes.push(Number.parseInt(hex, 16));
    i += 2;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  // Only the encoder's own spelling: `_41` for `A` was not written by the app.
  return encodeBranchForRef(decoded) === encoded ? decoded : null;
}

function parseArchivedRef(line: string): ArchivedRef | null {
  const [type, sha, ref, committed] = line.split('\0');
  if (type !== 'commit' || !sha || !COMMIT_SHA.test(sha) || !ref) {
    return null;
  }
  const committedAt = new Date(Number(committed) * 1000);
  if (Number.isNaN(committedAt.getTime())) {
    return null;
  }
  const workspaceId = archiveRefWorkspaceId(ref);
  if (workspaceId) {
    return { ref, sha, kind: 'ARCHIVE', workspaceId, branchName: null, committedAt };
  }
  // A pin is named after the commit it was created at; one that points
  // anywhere else was not left by branch cleanup.
  const [, encoded, pinnedSha] = DELETED_BRANCH_PIN.exec(ref) ?? [];
  const branchName = encoded && pinnedSha === sha ? decodeBranchFromRef(encoded) : null;
  if (branchName) {
    return { ref, sha, kind: 'DELETED_BRANCH', workspaceId: null, branchName, committedAt };
  }
  return null;
}

/**
 * Archive refs and deleted-branch pins that point directly at a commit and
 * have the exact shape the app writes. Anything else under those prefixes, and
 * every other app-private ref, is left out.
 */
export async function listArchivedRefs(repoPath: string): Promise<ArchivedRef[]> {
  const stdout = await git(repoPath, [
    'for-each-ref',
    '--format=%(objecttype)%00%(objectname)%00%(refname)%00%(committerdate:unix)',
    ARCHIVE_REF_PREFIX,
    DELETED_BRANCH_PIN_PREFIX,
  ]);
  return stdout.split('\n').flatMap((line) => {
    const parsed = line ? parseArchivedRef(line) : null;
    return parsed ? [parsed] : [];
  });
}

/**
 * Commits reachable from `shas` but from no local branch and no
 * remote-tracking ref, with their parents. A sha missing from the result is
 * reachable from a branch or remote-tracking ref.
 */
export async function findCommitsOffBranches(
  repoPath: string,
  shas: string[]
): Promise<Map<string, string[]>> {
  const unique = [...new Set(shas)].filter((sha) => COMMIT_SHA.test(sha));
  const commits = new Map<string, string[]>();
  for (let start = 0; start < unique.length; start += REV_LIST_CHUNK) {
    const chunk = unique.slice(start, start + REV_LIST_CHUNK);
    const stdout = await git(
      repoPath,
      ['rev-list', '--parents', ...chunk, '--not', '--branches', '--remotes'],
      REV_LIST_MAX_BUFFER
    );
    for (const line of stdout.split('\n')) {
      const [commit, ...parents] = line.trim().split(' ');
      if (commit) {
        commits.set(commit, parents);
      }
    }
  }
  return commits;
}

/** How many commits reachable from `sha` are in `offBranches` (see {@link findCommitsOffBranches}). */
export function countCommitsOffBranches(sha: string, offBranches: Map<string, string[]>): number {
  const seen = new Set<string>();
  const pending = [sha];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const parents = offBranches.get(next);
    if (parents && !seen.has(next)) {
      seen.add(next);
      pending.push(...parents);
    }
  }
  return seen.size;
}

/** Folder names of every worktree Git has registered for the repository. */
export async function listRegisteredWorktreeNames(repoPath: string): Promise<Set<string>> {
  const porcelain = await git(repoPath, ['worktree', 'list', '--porcelain', '-z']);
  const names = new Set<string>();
  for (const field of porcelain.split('\0')) {
    if (field.startsWith('worktree ')) {
      names.add(path.basename(field.slice('worktree '.length)));
    }
  }
  return names;
}

/**
 * When a loose ref file was last written, or null when the ref is packed (or
 * stored some other way). Never earlier than the ref's creation. `commonDir`
 * is the repository's shared Git directory (its cleanup identity).
 */
export async function looseRefWrittenAt(commonDir: string, ref: string): Promise<Date | null> {
  try {
    return (await stat(path.join(commonDir, ...ref.split('/')))).mtime;
  } catch (error) {
    // Any other failure must not pass for "packed", which would leave only
    // the commit date to age the ref; it skips the repository instead.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export type RefDeletionOutcome =
  | { status: 'removed' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

/** Delete an archive ref or pin only while it still points at `expectedSha`. */
export async function deleteArchivedRef(
  repoPath: string,
  ref: string,
  expectedSha: string
): Promise<RefDeletionOutcome> {
  assertAppPrivateRef(ref);
  if (!(archiveRefWorkspaceId(ref) || DELETED_BRANCH_PIN.test(ref))) {
    throw new Error(`Refusing to delete a ref outside the archive and pin families: ${ref}`);
  }
  if (!COMMIT_SHA.test(expectedSha)) {
    throw new Error(`Invalid commit SHA: ${expectedSha}`);
  }
  const deletion = await execCommand('git', [
    '-C',
    repoPath,
    'update-ref',
    '--no-deref',
    '-d',
    ref,
    expectedSha,
  ]);
  if (deletion.code === 0) {
    return { status: 'removed' };
  }
  const current = await readRefSha(repoPath, ref);
  if (current === null) {
    return { status: 'skipped', reason: 'Ref no longer exists' };
  }
  if (current !== expectedSha) {
    return { status: 'skipped', reason: 'Ref moved since it was listed' };
  }
  return { status: 'failed', error: deletion.stderr.trim() || `exit ${deletion.code}` };
}
