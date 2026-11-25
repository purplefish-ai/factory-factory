import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gitOpsService } from './git-ops.service';
import { worktreeLifecycleService } from './worktree-lifecycle.service';

const execFileAsync = promisify(execFile);
const ARCHIVE_REF = 'refs/factory-factory/archive/ws-1';

type Workspace = Parameters<typeof worktreeLifecycleService.snapshotWorkspaceWorktree>[0];

let testRoot: string;
let repoPath: string;
let worktreeBasePath: string;
let worktreePath: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  return unsafeCoerce<Workspace>({
    id: 'ws-1',
    status: 'READY',
    name: 'Snapshot test',
    branchName: 'ws-branch',
    initErrorMessage: null,
    worktreePath,
    project: { repoPath, worktreeBasePath },
    ...overrides,
  });
}

/** Uncommitted work of every kind: a staged edit, an unstaged edit, an untracked file. */
async function makeUncommittedChanges(): Promise<void> {
  await writeFile(path.join(worktreePath, 'staged.txt'), 'staged change\n');
  await git(worktreePath, 'add', 'staged.txt');
  await writeFile(path.join(worktreePath, 'tracked.txt'), 'unstaged change\n');
  await writeFile(path.join(worktreePath, 'untracked.txt'), 'untracked\n');
}

async function archiveRef(): Promise<string> {
  return await git(repoPath, 'rev-parse', '--verify', `${ARCHIVE_REF}^{commit}`);
}

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'ff-archive-snapshot-'));
  repoPath = path.join(testRoot, 'repo');
  worktreeBasePath = path.join(testRoot, 'worktrees');
  worktreePath = path.join(worktreeBasePath, 'workspace-ws-1');
  await mkdir(repoPath);
  await mkdir(worktreeBasePath);
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.name', 'Test');
  await git(repoPath, 'config', 'user.email', 'test@example.invalid');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  for (const name of ['tracked.txt', 'staged.txt', 'keep-1.txt', 'keep-2.txt', 'keep-3.txt']) {
    await writeFile(path.join(repoPath, name), `${name}\n`);
  }
  await git(repoPath, 'add', '-A');
  await git(repoPath, 'commit', '-m', 'Initial');
  await git(repoPath, 'worktree', 'add', '-b', 'ws-branch', worktreePath);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('archive snapshot against real Git', () => {
  it('commits onto the workspace branch when HEAD is on it, and points the ref there', async () => {
    const before = await git(repoPath, 'rev-parse', 'ws-branch');
    await makeUncommittedChanges();

    await worktreeLifecycleService.snapshotWorkspaceWorktree(makeWorkspace(), {});

    const tip = await git(repoPath, 'rev-parse', 'ws-branch');
    expect(tip).not.toBe(before);
    expect(await git(repoPath, 'rev-parse', `${tip}^`)).toBe(before);
    expect(await git(repoPath, 'log', '-1', '--format=%s', tip)).toBe(
      'Archive workspace Snapshot test'
    );
    expect(await archiveRef()).toBe(tip);
    expect(await git(worktreePath, 'status', '--porcelain')).toBe('');
    expect(await git(repoPath, 'show', `${tip}:untracked.txt`)).toBe('untracked');
  });

  it('keeps a detached HEAD snapshot reachable after the worktree is removed', async () => {
    await git(worktreePath, 'checkout', '--detach');
    const head = await git(worktreePath, 'rev-parse', 'HEAD');
    const branchTip = await git(repoPath, 'rev-parse', 'ws-branch');
    await makeUncommittedChanges();
    const statusBefore = await git(worktreePath, 'status', '--porcelain');

    await worktreeLifecycleService.snapshotWorkspaceWorktree(makeWorkspace(), {});

    // Nothing the user checked out moved: HEAD, branches, index and files.
    expect(await git(worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(worktreePath, 'status', '--porcelain')).toBe(statusBefore);
    expect(await git(repoPath, 'rev-parse', 'ws-branch')).toBe(branchTip);
    const snapshot = await archiveRef();
    expect(await git(repoPath, 'rev-parse', `${snapshot}^`)).toBe(head);

    await worktreeLifecycleService.removeWorkspaceWorktree(makeWorkspace());
    await git(repoPath, 'gc', '--prune=now', '--quiet');

    expect(await archiveRef()).toBe(snapshot);
    expect(await git(repoPath, 'show', `${snapshot}:staged.txt`)).toBe('staged change');
    expect(await git(repoPath, 'show', `${snapshot}:tracked.txt`)).toBe('unstaged change');
    expect(await git(repoPath, 'show', `${snapshot}:untracked.txt`)).toBe('untracked');
  });

  it('does not advance another branch that HEAD is on', async () => {
    await git(worktreePath, 'switch', '-c', 'other');
    const otherTip = await git(repoPath, 'rev-parse', 'other');
    const branchTip = await git(repoPath, 'rev-parse', 'ws-branch');
    await makeUncommittedChanges();

    await worktreeLifecycleService.snapshotWorkspaceWorktree(makeWorkspace(), {});

    expect(await git(repoPath, 'rev-parse', 'other')).toBe(otherTip);
    expect(await git(repoPath, 'rev-parse', 'ws-branch')).toBe(branchTip);
    expect(await git(worktreePath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/other');
    const snapshot = await archiveRef();
    expect(await git(repoPath, 'rev-parse', `${snapshot}^`)).toBe(otherTip);
    expect(await git(repoPath, 'show', `${snapshot}:untracked.txt`)).toBe('untracked');
  });

  it('points the ref at HEAD for a clean tree without a new commit', async () => {
    const head = await git(worktreePath, 'rev-parse', 'HEAD');
    const commitCount = await git(repoPath, 'rev-list', '--all', '--count');

    await worktreeLifecycleService.snapshotWorkspaceWorktree(makeWorkspace(), {});

    expect(await archiveRef()).toBe(head);
    expect(await git(repoPath, 'rev-list', '--all', '--count')).toBe(commitCount);
  });

  it('reports what the snapshot captured, bounded, for the archive log', async () => {
    await git(worktreePath, 'checkout', '--detach');
    await makeUncommittedChanges();
    await rm(path.join(worktreePath, 'keep-1.txt'));

    const snapshot = await gitOpsService.snapshotForArchive(worktreePath, {
      ref: ARCHIVE_REF,
      message: 'Archive workspace Snapshot test',
      workspaceBranch: 'ws-branch',
    });

    expect(snapshot).toMatchObject({
      capture: 'private',
      changes: {
        total: 4,
        byStatus: { A: 1, D: 1, M: 2 },
        truncated: false,
      },
    });
    expect(snapshot.changes?.paths).toEqual(
      expect.arrayContaining(['A untracked.txt', 'D keep-1.txt', 'M staged.txt', 'M tracked.txt'])
    );
  });

  it('never commits the deletions of a partly removed worktree when archive is retried', async () => {
    await makeUncommittedChanges();
    await worktreeLifecycleService.snapshotWorkspaceWorktree(makeWorkspace(), {});
    const snapshot = await archiveRef();
    const branchTip = await git(repoPath, 'rev-parse', 'ws-branch');
    // An interrupted `git worktree remove` leaves the .git file and some files behind.
    for (const name of ['keep-1.txt', 'keep-2.txt', 'untracked.txt', 'tracked.txt']) {
      await rm(path.join(worktreePath, name));
    }

    for (const retried of [
      makeWorkspace({ status: 'ARCHIVING' }),
      makeWorkspace({
        status: 'FAILED',
        initErrorMessage: 'Archive incomplete: removal timed out. Archive again to finish.',
      }),
    ]) {
      await expect(worktreeLifecycleService.archiveRemovalMayHaveStarted(retried)).resolves.toBe(
        true
      );
    }
    await worktreeLifecycleService.cleanupWorkspaceWorktree(
      makeWorkspace({
        status: 'FAILED',
        initErrorMessage: 'Archive incomplete: removal timed out. Archive again to finish.',
      }),
      {}
    );

    expect(await git(repoPath, 'rev-parse', 'ws-branch')).toBe(branchTip);
    expect(await archiveRef()).toBe(snapshot);
    expect(await git(repoPath, 'show', `${snapshot}:keep-1.txt`)).toBe('keep-1.txt');
    await expect(readFile(path.join(worktreePath, 'staged.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
