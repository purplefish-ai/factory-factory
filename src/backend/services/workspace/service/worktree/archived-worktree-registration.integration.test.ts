import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchivedWorktreeRegistrationService } from './archived-worktree-registration.service';
import { removeWorktreeRegistrationOnly } from './worktree-registration-admin';

const execFileAsync = promisify(execFile);
let testRoot: string;
let repoPath: string;
let worktreeBasePath: string;

const git = async (...args: string[]) =>
  (await execFileAsync('git', args, { cwd: repoPath })).stdout;
const registeredPaths = async () =>
  (await git('worktree', 'list', '--porcelain'))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

async function addWorktree(worktreePath: string): Promise<string> {
  await git('worktree', 'add', '--detach', worktreePath);
  return worktreePath;
}

/** Leaves the registration behind, as an interrupted removal or a manual delete would. */
async function deleteDirectoryOnly(worktreePath: string): Promise<void> {
  await rm(worktreePath, { recursive: true, force: true });
}

beforeEach(async () => {
  testRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ff-archived-registrations-')));
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

function service(archivedIds: string[], projectId = 'project') {
  const findArchivedIds = vi.fn(async (requestedProjectId: string, ids: string[]) =>
    requestedProjectId === projectId
      ? new Set(ids.filter((id) => archivedIds.includes(id)))
      : new Set<string>()
  );
  return {
    findArchivedIds,
    cleanup: new ArchivedWorktreeRegistrationService({
      listProjects: async () => [{ id: 'project', repoPath, worktreeBasePath }],
      findArchivedIds,
    }),
  };
}

describe('leftover registrations of archived workspaces', () => {
  it('removes only our own registrations of archived workspaces whose directory is gone', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-archived'));
    const kept = await addWorktree(path.join(worktreeBasePath, 'workspace-archived-kept'));
    const active = await addWorktree(path.join(worktreeBasePath, 'workspace-active'));
    // Other tools register worktrees in the same repository.
    const foreignOutside = await addWorktree(path.join(testRoot, 'tool', 'workspace-archived2'));
    const foreignNested = await addWorktree(
      path.join(worktreeBasePath, 'nested', 'workspace-archived3')
    );
    const foreignName = await addWorktree(path.join(worktreeBasePath, 'agent-archived4'));
    const locked = await addWorktree(path.join(worktreeBasePath, 'workspace-archived5'));
    await git('worktree', 'lock', locked);
    await writeFile(path.join(kept, 'uncommitted.txt'), 'still here');
    for (const gone of [leftover, active, foreignOutside, foreignNested, foreignName, locked]) {
      await deleteDirectoryOnly(gone);
    }
    const { cleanup } = service([
      'archived',
      'archived-kept',
      'archived2',
      'archived3',
      'archived4',
      'archived5',
    ]);

    const result = await cleanup.removeLeftoverRegistrations({ limit: 20 });

    expect(result).toEqual({
      removed: [{ projectId: 'project', workspaceId: 'archived', path: leftover }],
      failed: [],
    });
    const registered = await registeredPaths();
    expect(registered).not.toContain(leftover);
    for (const untouched of [kept, active, foreignOutside, foreignNested, foreignName, locked]) {
      expect(registered).toContain(untouched);
    }
    // An existing directory is never deleted here, uncommitted files included.
    expect(await readFile(path.join(kept, 'uncommitted.txt'), 'utf8')).toBe('still here');
  });

  it('leaves a directory that reappears between detection and removal, and its registration', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-returning'));
    await deleteDirectoryOnly(leftover);
    const cleanup = new ArchivedWorktreeRegistrationService({
      listProjects: async () => [{ id: 'project', repoPath, worktreeBasePath }],
      // Runs after the candidates are found and before any removal.
      findArchivedIds: async (_projectId, ids) => {
        await mkdir(leftover);
        await writeFile(path.join(leftover, 'uncommitted.txt'), 'came back');
        return new Set(ids);
      },
    });

    await expect(cleanup.removeLeftoverRegistrations({ limit: 20 })).resolves.toEqual({
      removed: [],
      failed: [],
    });
    expect(await readFile(path.join(leftover, 'uncommitted.txt'), 'utf8')).toBe('came back');
    expect(await registeredPaths()).toContain(leftover);
  });

  it('does not remove a registration for an archived workspace of another project', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-elsewhere'));
    await deleteDirectoryOnly(leftover);
    const { cleanup, findArchivedIds } = service(['elsewhere'], 'other-project');

    await expect(cleanup.removeLeftoverRegistrations({ limit: 20 })).resolves.toEqual({
      removed: [],
      failed: [],
    });
    expect(findArchivedIds).toHaveBeenCalledWith('project', ['elsewhere']);
    expect(await registeredPaths()).toContain(leftover);
  });

  it('removes at most the limit, and nothing once the signal has aborted', async () => {
    const leftovers = [];
    for (const id of ['a', 'b', 'c']) {
      const leftover = await addWorktree(path.join(worktreeBasePath, `workspace-${id}`));
      await deleteDirectoryOnly(leftover);
      leftovers.push(leftover);
    }
    const { cleanup } = service(['a', 'b', 'c']);
    const aborted = new AbortController();
    aborted.abort();

    expect(
      (await cleanup.removeLeftoverRegistrations({ limit: 20, signal: aborted.signal })).removed
    ).toEqual([]);
    expect((await cleanup.removeLeftoverRegistrations({ limit: 2 })).removed).toHaveLength(2);
    const registered = await registeredPaths();
    expect(leftovers.filter((leftover) => registered.includes(leftover))).toHaveLength(1);
  });

  it('reports a project whose repository cannot be listed and continues', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-next'));
    await deleteDirectoryOnly(leftover);
    const cleanup = new ArchivedWorktreeRegistrationService({
      listProjects: async () => [
        { id: 'missing', repoPath: path.join(testRoot, 'missing'), worktreeBasePath },
        { id: 'project', repoPath, worktreeBasePath },
      ],
      findArchivedIds: async (_projectId, ids) => new Set(ids),
    });

    const result = await cleanup.removeLeftoverRegistrations({ limit: 20 });

    expect(result.failed).toEqual([
      { projectId: 'missing', path: null, error: expect.stringContaining('Failed to list') },
    ]);
    expect(result.removed).toEqual([{ projectId: 'project', workspaceId: 'next', path: leftover }]);
  });
});

describe('registration-only removal', () => {
  const adminDirs = async () => (await readdir(path.join(repoPath, '.git', 'worktrees'))).sort();

  it('deletes only the admin directory, so the path can be registered again', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-gone'));
    const kept = await addWorktree(path.join(worktreeBasePath, 'workspace-kept'));
    await deleteDirectoryOnly(leftover);

    await expect(removeWorktreeRegistrationOnly(repoPath, leftover)).resolves.toBe('removed');

    expect(await adminDirs()).toEqual(['workspace-kept']);
    expect(await registeredPaths()).toEqual([repoPath, kept]);
    await expect(addWorktree(leftover)).resolves.toBe(leftover);
  });

  it('never touches a path that exists, and leaves its registration', async () => {
    const present = await addWorktree(path.join(worktreeBasePath, 'workspace-present'));
    await writeFile(path.join(present, 'uncommitted.txt'), 'kept');

    await expect(removeWorktreeRegistrationOnly(repoPath, present)).resolves.toBe(
      'directory-present'
    );
    expect(await readFile(path.join(present, 'uncommitted.txt'), 'utf8')).toBe('kept');
    expect(await registeredPaths()).toContain(present);
  });

  it('leaves a locked registration, and reports one it cannot find', async () => {
    const locked = await addWorktree(path.join(worktreeBasePath, 'workspace-locked'));
    await git('worktree', 'lock', locked);
    await deleteDirectoryOnly(locked);

    await expect(removeWorktreeRegistrationOnly(repoPath, locked)).resolves.toBe('locked');
    await expect(
      removeWorktreeRegistrationOnly(repoPath, path.join(worktreeBasePath, 'workspace-none'))
    ).resolves.toBe('not-found');
    expect(await registeredPaths()).toContain(locked);
  });

  it('never follows a symlinked admin root out of the Git directory', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-redirected'));
    await deleteDirectoryOnly(leftover);
    // Move the real admin root away and point `.git/worktrees` at it.
    const outside = path.join(testRoot, 'outside-worktrees');
    await rename(path.join(repoPath, '.git', 'worktrees'), outside);
    await symlink(outside, path.join(repoPath, '.git', 'worktrees'));

    await expect(removeWorktreeRegistrationOnly(repoPath, leftover)).resolves.toBe('not-found');
    expect(await readdir(outside)).toEqual(['workspace-redirected']);
  });

  it('never follows a symlinked admin directory', async () => {
    const leftover = await addWorktree(path.join(worktreeBasePath, 'workspace-linked'));
    await deleteDirectoryOnly(leftover);
    const admin = path.join(repoPath, '.git', 'worktrees', 'workspace-linked');
    const outside = path.join(testRoot, 'outside-admin');
    await rename(admin, outside);
    await symlink(outside, admin);

    await expect(removeWorktreeRegistrationOnly(repoPath, leftover)).resolves.toBe('not-found');
    expect(await readdir(outside)).toContain('gitdir');
  });

  it('matches a registration recorded with relative paths', async () => {
    const leftover = path.join(worktreeBasePath, 'workspace-relative');
    await git('-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '--detach', leftover);
    // Git before 2.48 ignores the setting; this test must then fail, not pass vacuously.
    const recorded = await readFile(
      path.join(repoPath, '.git', 'worktrees', 'workspace-relative', 'gitdir'),
      'utf8'
    );
    expect(path.isAbsolute(recorded.trim())).toBe(false);
    await deleteDirectoryOnly(leftover);

    await expect(removeWorktreeRegistrationOnly(repoPath, leftover)).resolves.toBe('removed');
    expect(await registeredPaths()).toEqual([repoPath]);
  });
});
