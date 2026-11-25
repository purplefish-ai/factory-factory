import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceBranchCleanupAccessor } from '@/backend/services/workspace/resources/workspace-branch-cleanup.accessor';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { formatArchiveIncompleteMessage } from '@/shared/workspace-archive-incomplete';
import type { Prisma, PrismaClient } from '@prisma-gen/client';
import { archivedBranchCleanupService } from './archived-branch-cleanup.service';
import { deletedBranchPinRef, encodeBranchForRef } from './archived-branch-git';
import {
  type ArchivedRefCandidate,
  type ArchivedRefRemovalRequest,
  archivedRefCleanupService,
} from './archived-ref-cleanup.service';
import {
  countCommitsOffBranches,
  decodeBranchFromRef,
  looseRefWrittenAt,
} from './archived-ref-git';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test database');
    }
    return database.prisma;
  },
}));

const gitHooks = vi.hoisted(() => ({
  beforeFindCommitsOffBranches: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('./archived-ref-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./archived-ref-git')>();
  return {
    ...actual,
    findCommitsOffBranches: async (...args: Parameters<typeof actual.findCommitsOffBranches>) => {
      await gitHooks.beforeFindCommitsOffBranches?.();
      return actual.findCommitsOffBranches(...args);
    },
  };
});

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};
const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 45 * DAY);

let db: IntegrationDatabase;
let testRoot: string;
let repoPath: string;

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...GIT_ENV, ...env } });
  return stdout.trim();
}

async function refSha(ref: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null;
  }
}

/** A commit on top of `parent` that no branch reaches, committed at `date`. */
async function commitAside(parent: string, date = new Date()): Promise<string> {
  const tree = await git(repoPath, ['rev-parse', `${parent}^{tree}`]);
  const stamp = `${Math.floor(date.getTime() / 1000)} +0000`;
  return await git(repoPath, ['commit-tree', tree, '-p', parent, '-m', 'Archive workspace'], {
    GIT_COMMITTER_DATE: stamp,
    GIT_AUTHOR_DATE: stamp,
  });
}

/** Point a ref at `sha`; `writtenAt` back-dates the loose ref file. */
async function writeRef(ref: string, sha: string, writtenAt?: Date): Promise<void> {
  await git(repoPath, ['update-ref', ref, sha]);
  if (writtenAt) {
    const file = path.join(repoPath, '.git', ...ref.split('/'));
    await utimes(file, writtenAt, writtenAt);
  }
}

const archiveRef = (workspaceId: string) => `refs/factory-factory/archive/${workspaceId}`;

let workspaceCounter = 0;
async function createWorkspace(
  data: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}
): Promise<string> {
  const id = `ws-${++workspaceCounter}`;
  await db.prisma.workspace.create({
    data: {
      id,
      projectId: 'project',
      name: `Workspace ${workspaceCounter}`,
      status: 'ARCHIVED',
      branchName: `user/${id}`,
      worktreePath: path.join(testRoot, 'worktrees', `workspace-${id}`),
      ...data,
    },
  });
  return id;
}

async function candidates(): Promise<Record<string, ArchivedRefCandidate>> {
  const groups = await archivedRefCleanupService.findCandidates();
  return Object.fromEntries(groups.flatMap((group) => group.refs.map((ref) => [ref.ref, ref])));
}

async function tiers(): Promise<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(await candidates()).map(([ref, candidate]) => [ref, candidate.tier])
  );
}

function requestFor(candidate: ArchivedRefCandidate): ArchivedRefRemovalRequest {
  return { projectId: 'project', ref: candidate.ref, sha: candidate.sha, tier: candidate.tier };
}

/** A redundant archive ref, so an exclusion test cannot pass because detection failed. */
const CONTROL_REF = archiveRef('control');
async function createControlRef(): Promise<void> {
  await writeRef(CONTROL_REF, await git(repoPath, ['rev-parse', 'main']));
}

let mainSha: string;

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
  testRoot = await mkdtemp(path.join(tmpdir(), 'ff-ref-cleanup-'));
  const originPath = path.join(testRoot, 'origin.git');
  repoPath = path.join(testRoot, 'repo');
  await mkdir(repoPath);
  await git(testRoot, ['init', '--quiet', '--bare', '-b', 'main', originPath]);
  await git(repoPath, ['init', '--quiet', '-b', 'main']);
  await git(repoPath, ['commit', '--quiet', '--allow-empty', '-m', 'Initial']);
  await git(repoPath, ['remote', 'add', 'origin', originPath]);
  await git(repoPath, ['push', '--quiet', 'origin', 'main']);
  mainSha = await git(repoPath, ['rev-parse', 'main']);

  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath,
      worktreeBasePath: path.join(testRoot, 'worktrees'),
    },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  gitHooks.beforeFindCommitsOffBranches = undefined;
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('archived ref candidates', () => {
  it('lists refs whose commit a local branch or remote-tracking ref reaches as redundant', async () => {
    const archived = await createWorkspace({ name: 'Pushed work' });
    await writeRef(archiveRef(archived), mainSha);
    // Only a remote-tracking ref reaches this one.
    const pushed = await commitAside(mainSha);
    await git(repoPath, ['push', '--quiet', 'origin', `${pushed}:refs/heads/user/pushed`]);
    await git(repoPath, ['fetch', '--quiet', 'origin']);
    const pin = deletedBranchPinRef('user/pushed', pushed);
    await writeRef(pin, pushed);
    // A deleted workspace's ref whose commit is on a local branch.
    const local = await commitAside(mainSha);
    await git(repoPath, ['branch', 'user/local', local]);
    await writeRef(archiveRef('deleted-workspace'), local);

    const listed = await candidates();
    expect(Object.keys(listed).sort()).toEqual(
      [archiveRef(archived), archiveRef('deleted-workspace'), pin].sort()
    );
    expect(listed[archiveRef(archived)]).toMatchObject({
      tier: 'REDUNDANT',
      kind: 'ARCHIVE',
      workspaceId: archived,
      workspaceName: 'Pushed work',
      unsharedCommits: 0,
    });
    expect(listed[archiveRef('deleted-workspace')]).toMatchObject({
      tier: 'REDUNDANT',
      workspaceName: null,
    });
    expect(listed[pin]).toMatchObject({
      tier: 'REDUNDANT',
      kind: 'DELETED_BRANCH',
      branchName: 'user/pushed',
    });
    const [group] = await archivedRefCleanupService.findCandidates();
    expect(group).toMatchObject({ projectId: 'project', projectNames: ['Project'], repoPath });
  });

  it.each([
    { label: 'READY', data: { status: 'READY' as const } },
    { label: 'ARCHIVING', data: { status: 'ARCHIVING' as const } },
    {
      label: 'FAILED (archive incomplete)',
      data: {
        status: 'FAILED' as const,
        initErrorMessage: formatArchiveIncompleteMessage('worktree removal timed out'),
      },
    },
  ])('keeps the archive refs of a $label workspace', async ({ data }) => {
    await createControlRef();
    // Neither a redundant ref nor an old one holding unique work is offered.
    const redundant = await createWorkspace({ ...data, updatedAt: OLD });
    await writeRef(archiveRef(redundant), mainSha);
    const unique = await createWorkspace({ ...data, updatedAt: OLD });
    await writeRef(archiveRef(unique), await commitAside(mainSha, OLD), OLD);

    await expect(tiers()).resolves.toEqual({ [CONTROL_REF]: 'REDUNDANT' });
  });

  it('keeps the archive ref of a workspace whose worktree Git still has registered', async () => {
    await createControlRef();
    const id = await createWorkspace();
    await git(repoPath, [
      'worktree',
      'add',
      '--quiet',
      '--detach',
      path.join(testRoot, 'elsewhere', `workspace-${id}`),
      'main',
    ]);
    await writeRef(archiveRef(id), mainSha);

    await expect(tiers()).resolves.toEqual({ [CONTROL_REF]: 'REDUNDANT' });
  });

  it('never offers a ref holding work found nowhere else until it is 30 days old', async () => {
    await createControlRef();
    // Committed long ago, but archived recently.
    const recentlyArchived = await createWorkspace();
    await writeRef(archiveRef(recentlyArchived), await commitAside(mainSha, OLD), OLD);
    // Archived long ago, but the ref file was written recently.
    const recentlyWritten = await createWorkspace({ updatedAt: OLD });
    await writeRef(archiveRef(recentlyWritten), await commitAside(mainSha, OLD));
    // A pin of a recent commit.
    const recentCommit = await commitAside(mainSha);
    await writeRef(deletedBranchPinRef('user/recent', recentCommit), recentCommit, OLD);

    await expect(tiers()).resolves.toEqual({ [CONTROL_REF]: 'REDUNDANT' });
  });

  it('lists old refs holding work found nowhere else separately, with the commits only they reach', async () => {
    const archived = await createWorkspace({ name: 'Old work', updatedAt: OLD });
    const first = await commitAside(mainSha, OLD);
    const second = await commitAside(first, OLD);
    await writeRef(archiveRef(archived), second, OLD);
    // A deleted workspace's ref, packed so no loose file dates it.
    await writeRef(archiveRef('deleted-workspace'), await commitAside(mainSha, OLD));
    await git(repoPath, ['pack-refs', '--all']);
    const pinned = await commitAside(mainSha, OLD);
    const pin = deletedBranchPinRef('user/squashed', pinned);
    await writeRef(pin, pinned, OLD);

    const listed = await candidates();
    expect(listed[archiveRef(archived)]).toMatchObject({
      tier: 'UNIQUE_WORK',
      workspaceName: 'Old work',
      unsharedCommits: 2,
    });
    expect(listed[archiveRef('deleted-workspace')]).toMatchObject({
      tier: 'UNIQUE_WORK',
      workspaceName: null,
      unsharedCommits: 1,
    });
    expect(listed[pin]).toMatchObject({
      tier: 'UNIQUE_WORK',
      branchName: 'user/squashed',
      unsharedCommits: 1,
    });
    expect(listed[archiveRef(archived)]?.datedAt.getTime()).toBeLessThan(Date.now() - 30 * DAY);
  });

  it('leaves every other app-private ref alone', async () => {
    await createControlRef();
    const foreign = [
      'refs/factory-factory/review/pr-12',
      'refs/factory-factory/archive/nested/ws',
      'refs/factory-factory/deleted-branches/user_2Fx',
      'refs/factory-factory/deleted-branches/not.encoded/abc',
      // Named after another commit than the one it points at.
      `refs/factory-factory/deleted-branches/user_2Fy/${'0'.repeat(40)}`,
      // `user` spelled with an escape the encoder never writes.
      `refs/factory-factory/deleted-branches/_75ser/${mainSha}`,
      'refs/factory-factory/archived/ws',
    ];
    for (const ref of foreign) {
      await writeRef(ref, mainSha);
    }
    await git(repoPath, ['tag', '-a', '-m', 'tag', 'v1', 'main']);
    await writeRef(archiveRef('tag-object'), await git(repoPath, ['rev-parse', 'refs/tags/v1']));

    await expect(tiers()).resolves.toEqual({ [CONTROL_REF]: 'REDUNDANT' });

    const result = await archivedRefCleanupService.removeRefs(
      [...foreign, archiveRef('tag-object')].map((ref) => ({
        projectId: 'project',
        ref,
        sha: mainSha,
        tier: 'UNIQUE_WORK' as const,
      }))
    );
    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(foreign.length + 1);
    for (const ref of foreign) {
      expect(await refSha(ref)).toBe(mainSha);
    }
    // About twenty Git processes; give a loaded machine room.
  }, 30_000);

  it('skips repositories used only by archived projects', async () => {
    await writeRef(archiveRef('deleted-workspace'), mainSha);
    await db.prisma.project.update({ where: { id: 'project' }, data: { isArchived: true } });

    await expect(tiers()).resolves.toEqual({});
  });
});

describe('archived ref removal', () => {
  it('deletes the listed refs and nothing else', async () => {
    const archived = await createWorkspace({ updatedAt: OLD });
    await writeRef(archiveRef(archived), mainSha);
    const old = await createWorkspace({ updatedAt: OLD });
    await writeRef(archiveRef(old), await commitAside(mainSha, OLD), OLD);
    await writeRef('refs/factory-factory/review/pr-1', mainSha);
    const listed = Object.values(await candidates());
    expect(listed).toHaveLength(2);

    const result = await archivedRefCleanupService.removeRefs(listed.map(requestFor));

    expect(result).toEqual({
      removed: expect.arrayContaining([
        { projectId: 'project', ref: archiveRef(archived) },
        { projectId: 'project', ref: archiveRef(old) },
      ]),
      skipped: [],
      failed: [],
    });
    expect(await refSha(archiveRef(archived))).toBeNull();
    expect(await refSha(archiveRef(old))).toBeNull();
    expect(await refSha('refs/factory-factory/review/pr-1')).toBe(mainSha);
    expect(await refSha('refs/heads/main')).toBe(mainSha);
  });

  it('skips a ref that moved since it was listed', async () => {
    const id = await createWorkspace();
    await writeRef(archiveRef(id), mainSha);
    const [candidate] = Object.values(await candidates());
    const moved = await commitAside(mainSha);
    await git(repoPath, ['branch', 'user/moved', moved]);
    await writeRef(archiveRef(id), moved);

    const result = await archivedRefCleanupService.removeRefs([requestFor(candidate!)]);

    expect(result.skipped).toEqual([
      { projectId: 'project', ref: archiveRef(id), reason: 'Ref moved since it was listed' },
    ]);
    expect(await refSha(archiveRef(id))).toBe(moved);
  });

  it('deletes only if the ref still points at the listed commit at deletion time', async () => {
    const id = await createWorkspace();
    await writeRef(archiveRef(id), mainSha);
    const [candidate] = Object.values(await candidates());
    const moved = await commitAside(mainSha);
    await git(repoPath, ['branch', 'user/moved', moved]);
    const status = workspaceBranchCleanupAccessor.findWorkspaceStatus.bind(
      workspaceBranchCleanupAccessor
    );
    vi.spyOn(workspaceBranchCleanupAccessor, 'findWorkspaceStatus').mockImplementationOnce(
      async (workspaceId) => {
        await writeRef(archiveRef(id), moved);
        return status(workspaceId);
      }
    );

    const result = await archivedRefCleanupService.removeRefs([requestFor(candidate!)]);

    expect(result.skipped).toEqual([
      { projectId: 'project', ref: archiveRef(id), reason: 'Ref moved since it was listed' },
    ]);
    expect(await refSha(archiveRef(id))).toBe(moved);
  });

  it('keeps a ref listed as redundant that now holds work found nowhere else', async () => {
    const id = await createWorkspace({ updatedAt: OLD });
    const work = await commitAside(mainSha, OLD);
    await git(repoPath, ['branch', 'user/work', work]);
    await writeRef(archiveRef(id), work, OLD);
    const [candidate] = Object.values(await candidates());
    expect(candidate?.tier).toBe('REDUNDANT');
    await git(repoPath, ['branch', '-D', 'user/work']);

    const result = await archivedRefCleanupService.removeRefs([requestFor(candidate!)]);

    expect(result.skipped).toEqual([
      { projectId: 'project', ref: archiveRef(id), reason: 'Now holds work found nowhere else' },
    ]);
    expect(await refSha(archiveRef(id))).toBe(work);
  });

  it('keeps a ref whose commit a branch stops reaching just before deletion', async () => {
    const id = await createWorkspace({ updatedAt: OLD });
    const work = await commitAside(mainSha, OLD);
    await git(repoPath, ['branch', 'user/work', work]);
    await writeRef(archiveRef(id), work, OLD);
    const [candidate] = Object.values(await candidates());
    // Re-detection (the first check) still sees the branch; the check just
    // before deletion (the second) does not.
    let checks = 0;
    gitHooks.beforeFindCommitsOffBranches = async () => {
      checks += 1;
      if (checks === 2) {
        await git(repoPath, ['branch', '-D', 'user/work']);
      }
    };

    const result = await archivedRefCleanupService.removeRefs([requestFor(candidate!)]);

    expect(result.skipped).toEqual([
      { projectId: 'project', ref: archiveRef(id), reason: 'Now holds work found nowhere else' },
    ]);
    expect(await refSha(archiveRef(id))).toBe(work);
  });

  it('keeps an archive ref whose workspace is no longer archived at deletion time', async () => {
    const id = await createWorkspace();
    await writeRef(archiveRef(id), mainSha);
    const [candidate] = Object.values(await candidates());
    vi.spyOn(workspaceBranchCleanupAccessor, 'findWorkspaceStatus').mockResolvedValueOnce(
      'ARCHIVING'
    );

    const result = await archivedRefCleanupService.removeRefs([requestFor(candidate!)]);

    expect(result.skipped).toEqual([
      { projectId: 'project', ref: archiveRef(id), reason: 'Workspace is not archived' },
    ]);
    expect(await refSha(archiveRef(id))).toBe(mainSha);
  });

  it('skips a ref whose workspace stopped qualifying before removal', async () => {
    await writeRef(archiveRef('reused'), mainSha);
    const [candidate] = Object.values(await candidates());
    await db.prisma.workspace.create({
      data: { id: 'reused', projectId: 'project', name: 'Reused', status: 'ARCHIVING' },
    });

    const result = await archivedRefCleanupService.removeRefs([requestFor(candidate!)]);

    expect(result.skipped).toEqual([
      { projectId: 'project', ref: archiveRef('reused'), reason: 'No longer eligible for cleanup' },
    ]);
    expect(await refSha(archiveRef('reused'))).toBe(mainSha);
  });

  it('runs one cleanup at a time, shared with branch cleanup', async () => {
    const id = await createWorkspace();
    await writeRef(archiveRef(id), mainSha);
    const [candidate] = Object.values(await candidates());
    const request = [requestFor(candidate!)];

    const first = archivedRefCleanupService.removeRefs(request);
    await expect(archivedRefCleanupService.removeRefs(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      archivedBranchCleanupService.removeBranches([
        { projectId: 'project', name: 'user/x', sha: mainSha },
      ])
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(first).resolves.toMatchObject({ removed: [{ ref: archiveRef(id) }] });
  });
});

describe('archived ref helpers', () => {
  it('decodes every encoded branch name and rejects anything else', () => {
    for (const name of ['user/feature', 'a.b/c_d', 'feature/ü', 'x-y']) {
      expect(decodeBranchFromRef(encodeBranchForRef(name))).toBe(name);
    }
    expect(decodeBranchFromRef('a_2')).toBeNull();
    expect(decodeBranchFromRef('a_zz')).toBeNull();
    expect(decodeBranchFromRef('_FF')).toBeNull();
    // Valid escapes the encoder would never produce.
    expect(decodeBranchFromRef('_41')).toBeNull();
    expect(decodeBranchFromRef('a_2Db')).toBeNull();
    expect(decodeBranchFromRef('_2D')).toBeNull();
  });

  it('dates only loose refs, and fails rather than guess when the ref store cannot be read', async () => {
    await writeRef(archiveRef('loose'), mainSha, OLD);
    const commonDir = path.join(repoPath, '.git');
    expect((await looseRefWrittenAt(commonDir, archiveRef('loose')))?.getTime()).toBe(
      OLD.getTime()
    );
    await git(repoPath, ['pack-refs', '--all']);
    await expect(looseRefWrittenAt(commonDir, archiveRef('loose'))).resolves.toBeNull();
    // A path through a file, as when the store is not the one expected.
    await expect(
      looseRefWrittenAt(path.join(commonDir, 'HEAD'), archiveRef('loose'))
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('counts the commits only a ref reaches, once each', () => {
    const graph = new Map([
      ['d', ['b', 'c']],
      ['b', ['a']],
      ['c', ['a']],
      ['a', ['on-branch']],
    ]);
    expect(countCommitsOffBranches('d', graph)).toBe(4);
    expect(countCommitsOffBranches('c', graph)).toBe(2);
    expect(countCommitsOffBranches('on-branch', graph)).toBe(0);
  });
});
