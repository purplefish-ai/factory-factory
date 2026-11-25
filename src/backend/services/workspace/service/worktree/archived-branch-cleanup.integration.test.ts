import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { Prisma, PrismaClient } from '@prisma-gen/client';
import { archivedBranchCleanupService } from './archived-branch-cleanup.service';
import { deletedBranchPinRef, encodeBranchForRef, pinAndDeleteBranch } from './archived-branch-git';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test database');
    }
    return database.prisma;
  },
}));

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

let db: IntegrationDatabase;
let testRoot: string;
let repoPath: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function branchSha(name: string): Promise<string | null> {
  try {
    return await git(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`);
  } catch {
    return null;
  }
}

/** Create a branch off main with one commit of its own, optionally pushed to origin. */
async function createBranch(name: string, options: { push?: boolean } = {}): Promise<string> {
  await git(repoPath, 'branch', name, 'main');
  const tree = await git(repoPath, 'rev-parse', 'main^{tree}');
  const commit = await git(repoPath, 'commit-tree', tree, '-p', name, '-m', `Work on ${name}`);
  await git(repoPath, 'update-ref', `refs/heads/${name}`, commit);
  if (options.push) {
    await git(repoPath, 'push', '--quiet', 'origin', name);
  }
  return commit;
}

let workspaceCounter = 0;
async function createWorkspace(
  branchName: string,
  data: Partial<Prisma.WorkspaceUncheckedCreateInput> & { mergedPr?: boolean } = {}
): Promise<string> {
  const { mergedPr, ...rest } = data;
  const id = `ws-${++workspaceCounter}`;
  await db.prisma.workspace.create({
    data: {
      id,
      projectId: 'project',
      name: id,
      status: 'ARCHIVED',
      branchName,
      worktreePath: path.join(testRoot, 'worktrees', `workspace-${id}`),
      ...rest,
    },
  });
  if (mergedPr) {
    await db.prisma.workspacePR.create({
      data: {
        workspaceId: id,
        url: `https://github.com/acme/repo/pull/${workspaceCounter}`,
        state: 'MERGED',
        headRefName: branchName,
      },
    });
  }
  return id;
}

async function candidateNames(): Promise<Record<string, string>> {
  const groups = await archivedBranchCleanupService.findCandidates();
  return Object.fromEntries(
    groups.flatMap((group) => group.branches.map((branch) => [branch.name, branch.safeBecause]))
  );
}

/** A qualifying branch, so an exclusion test cannot pass because detection failed. */
const CONTROL = { 'user/control': 'ON_REMOTE' };
async function createControlBranch(): Promise<void> {
  await createBranch('user/control', { push: true });
  await createWorkspace('user/control');
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'ff-branch-cleanup-'));
  const originPath = path.join(testRoot, 'origin.git');
  repoPath = path.join(testRoot, 'repo');
  await mkdir(repoPath);
  await git(testRoot, 'init', '--quiet', '--bare', '-b', 'main', originPath);
  await git(repoPath, 'init', '--quiet', '-b', 'main');
  await git(repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'Initial');
  await git(repoPath, 'remote', 'add', 'origin', originPath);
  await git(repoPath, 'push', '--quiet', 'origin', 'main');

  await db.prisma.workspacePR.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath,
      worktreeBasePath: path.join(testRoot, 'worktrees'),
      defaultBranch: 'develop',
    },
  });
});
afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('archived branch candidates', () => {
  it('lists branches whose commits are on a remote or in a merged pull request', async () => {
    await createBranch('user/pushed', { push: true });
    await createWorkspace('user/pushed');
    await createBranch('user/squashed');
    await createWorkspace('user/squashed', { mergedPr: true });

    await expect(candidateNames()).resolves.toEqual({
      'user/pushed': 'ON_REMOTE',
      'user/squashed': 'MERGED_PR',
    });
    const [group] = await archivedBranchCleanupService.findCandidates();
    expect(group).toMatchObject({ projectId: 'project', projectNames: ['Project'], repoPath });
  });

  it('excludes a branch whose commits are neither on a remote nor in a merged pull request', async () => {
    await createBranch('user/unpushed');
    await createWorkspace('user/unpushed');
    // A merged pull request for another head branch does not vouch for this one.
    await createBranch('user/other-head');
    const id = await createWorkspace('user/other-head');
    await db.prisma.workspacePR.create({
      data: {
        workspaceId: id,
        url: 'https://github.com/a/b/pull/9',
        state: 'MERGED',
        headRefName: 'x',
      },
    });
    // Neither does a merged pull request that was detached from the workspace.
    await createBranch('user/detached');
    const detached = await createWorkspace('user/detached', { mergedPr: true });
    await db.prisma.workspacePR.updateMany({
      where: { workspaceId: detached },
      data: { detachedAt: new Date() },
    });

    await createControlBranch();
    await expect(candidateNames()).resolves.toEqual(CONTROL);
  });

  it('excludes a branch a non-archived workspace also uses', async () => {
    await createBranch('user/shared', { push: true });
    await createWorkspace('user/shared');
    await createWorkspace('user/shared', { status: 'PROVISIONING', worktreePath: null });

    await createControlBranch();
    await expect(candidateNames()).resolves.toEqual(CONTROL);
  });

  it('excludes a non-archived workspace of another project using the same repository', async () => {
    await createBranch('user/shared', { push: true });
    await createWorkspace('user/shared');
    await db.prisma.project.create({
      data: {
        id: 'project-2',
        name: 'Second',
        slug: 'second',
        repoPath: `${repoPath}/`,
        worktreeBasePath: path.join(testRoot, 'worktrees-2'),
      },
    });
    await createWorkspace('user/shared', { projectId: 'project-2', status: 'READY' });

    await createControlBranch();
    await expect(candidateNames()).resolves.toEqual(CONTROL);
  });

  it('excludes the default branch and archived workspaces that never created a worktree', async () => {
    await createBranch('develop', { push: true });
    await createWorkspace('develop');
    await createBranch('user/base', { push: true });
    await createWorkspace('user/base', { worktreePath: null });

    await createControlBranch();
    await expect(candidateNames()).resolves.toEqual(CONTROL);
  });

  it('excludes branches checked out, rebased or bisected in any worktree', async () => {
    await createBranch('user/elsewhere', { push: true });
    await createWorkspace('user/elsewhere');
    await git(
      repoPath,
      'worktree',
      'add',
      '--quiet',
      path.join(testRoot, 'other-tool'),
      'user/elsewhere'
    );
    await createBranch('user/missing-folder', { push: true });
    await createWorkspace('user/missing-folder');
    const missing = path.join(testRoot, 'missing');
    await git(repoPath, 'worktree', 'add', '--quiet', missing, 'user/missing-folder');
    await rm(missing, { recursive: true, force: true });

    await createBranch('user/rebasing', { push: true });
    await createWorkspace('user/rebasing');
    await mkdir(path.join(repoPath, '.git', 'rebase-merge'));
    await writeFile(
      path.join(repoPath, '.git', 'rebase-merge', 'head-name'),
      'refs/heads/user/rebasing\n'
    );
    await createBranch('user/bisecting', { push: true });
    await createWorkspace('user/bisecting');
    await writeFile(path.join(repoPath, '.git', 'BISECT_START'), 'user/bisecting\n');

    await createControlBranch();
    await expect(candidateNames()).resolves.toEqual(CONTROL);
  });
});

describe('archived branch removal', () => {
  it('pins each tip under an app-private ref before deleting the local branch', async () => {
    const pushed = await createBranch('user/pushed', { push: true });
    await createWorkspace('user/pushed');
    const dotted = await createBranch('user.name/feature.v2_final');
    await createWorkspace('user.name/feature.v2_final', { mergedPr: true });

    const result = await archivedBranchCleanupService.removeBranches([
      { projectId: 'project', name: 'user/pushed', sha: pushed },
      { projectId: 'project', name: 'user.name/feature.v2_final', sha: dotted },
    ]);

    const dottedPin = `refs/factory-factory/deleted-branches/user_2Ename_2Ffeature_2Ev2_5Ffinal/${dotted}`;
    expect(result).toEqual({
      removed: [
        {
          projectId: 'project',
          name: 'user/pushed',
          pinRef: `refs/factory-factory/deleted-branches/user_2Fpushed/${pushed}`,
        },
        { projectId: 'project', name: 'user.name/feature.v2_final', pinRef: dottedPin },
      ],
      skipped: [],
      failed: [],
    });
    expect(await branchSha('user/pushed')).toBeNull();
    expect(await branchSha('user.name/feature.v2_final')).toBeNull();
    expect(await git(repoPath, 'rev-parse', dottedPin)).toBe(dotted);
    // Remote-tracking and remote branches are never touched.
    expect(await git(repoPath, 'rev-parse', 'refs/remotes/origin/user/pushed')).toBe(pushed);
    expect(
      await git(path.join(testRoot, 'origin.git'), 'rev-parse', 'refs/heads/user/pushed')
    ).toBe(pushed);
    await createControlBranch();
    await expect(candidateNames()).resolves.toEqual(CONTROL);
  });

  it('skips branches that moved, stopped qualifying or were never candidates', async () => {
    const listed = await createBranch('user/moved', { push: true });
    await createWorkspace('user/moved');
    const resumed = await createBranch('user/resumed', { push: true });
    await createWorkspace('user/resumed');
    const unpushed = await createBranch('user/unpushed');
    await createWorkspace('user/unpushed');
    await expect(candidateNames()).resolves.toEqual({
      'user/moved': 'ON_REMOTE',
      'user/resumed': 'ON_REMOTE',
    });

    // After the preview: one branch gains a commit, another is resumed.
    const tree = await git(repoPath, 'rev-parse', 'main^{tree}');
    const moved = await git(repoPath, 'commit-tree', tree, '-p', listed, '-m', 'More work');
    await git(repoPath, 'update-ref', 'refs/heads/user/moved', moved);
    await createWorkspace('user/resumed', { status: 'NEW', worktreePath: null });

    const result = await archivedBranchCleanupService.removeBranches([
      { projectId: 'project', name: 'user/moved', sha: listed },
      { projectId: 'project', name: 'user/resumed', sha: resumed },
      { projectId: 'project', name: 'user/unpushed', sha: unpushed },
      { projectId: 'unknown', name: 'user/moved', sha: listed },
    ]);

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map(({ name, reason }) => [name, reason])).toEqual([
      ['user/moved', 'No longer eligible for cleanup'],
      ['user/resumed', 'No longer eligible for cleanup'],
      ['user/unpushed', 'No longer eligible for cleanup'],
      ['user/moved', 'No longer eligible for cleanup'],
    ]);
    expect(await branchSha('user/moved')).toBe(moved);
    expect(await branchSha('user/resumed')).toBe(resumed);
    expect(await branchSha('user/unpushed')).toBe(unpushed);
  });

  it('leaves a branch alone when its tip differs from the expected commit', async () => {
    const tip = await createBranch('user/raced', { push: true });
    const tree = await git(repoPath, 'rev-parse', 'main^{tree}');
    const stale = await git(repoPath, 'commit-tree', tree, '-m', 'Unrelated');

    await expect(pinAndDeleteBranch(repoPath, 'user/raced', stale)).resolves.toEqual({
      status: 'skipped',
      reason: 'Branch moved since it was listed',
    });
    expect(await branchSha('user/raced')).toBe(tip);
    await expect(pinAndDeleteBranch(repoPath, 'user/gone', stale)).resolves.toEqual({
      status: 'skipped',
      reason: 'Branch no longer exists',
    });
  });

  it('rejects a second cleanup while one is running', async () => {
    const tip = await createBranch('user/pushed', { push: true });
    await createWorkspace('user/pushed');
    const request = [{ projectId: 'project', name: 'user/pushed', sha: tip }];

    const first = archivedBranchCleanupService.removeBranches(request);
    await expect(archivedBranchCleanupService.removeBranches(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(first).resolves.toMatchObject({ removed: [{ name: 'user/pushed' }] });
  });
});

describe('deleted-branch pin refs', () => {
  it('encodes every character outside [A-Za-z0-9-] so distinct names never collide', () => {
    expect(encodeBranchForRef('a.b/c_d')).toBe('a_2Eb_2Fc_5Fd');
    expect(encodeBranchForRef('a_2Eb')).not.toBe(encodeBranchForRef('a.b'));
    expect(encodeBranchForRef('feature/ü')).toBe('feature_2F_C3_BC');
    expect(() => deletedBranchPinRef('x', 'not-a-sha')).toThrow('Invalid commit SHA');
  });
});
