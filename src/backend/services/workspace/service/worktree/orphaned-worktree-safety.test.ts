import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCommandC } from '@/backend/lib/shell';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { orphanedWorktreeService } from './orphaned-worktree.service';

type Project = { id: string; name: string; repoPath: string; worktreeBasePath: string };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitCommandC(cwd, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(repoPath: string) {
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, 'init');
  await git(
    repoPath,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'initial'
  );
}

describe('orphaned worktree deletion safety with real Git repositories', () => {
  let root: string;
  let project: Project;
  let projects: Project[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'ff-orphan-safety-')));
    project = {
      id: 'one',
      name: 'One',
      repoPath: path.join(root, 'repo'),
      worktreeBasePath: path.join(root, 'worktrees'),
    };
    projects = [project];
    await initRepo(project.repoPath);
    vi.spyOn(projectAccessor, 'list').mockResolvedValue(
      unsafeCoerce<Awaited<ReturnType<typeof projectAccessor.list>>>(projects)
    );
    vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs').mockResolvedValue([]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function worktree(owner = project, name = 'workspace-old') {
    const worktreePath = path.join(owner.worktreeBasePath, name);
    await git(owner.repoPath, 'worktree', 'add', '-b', name, worktreePath);
    await writeFile(path.join(worktreePath, 'unsaved.txt'), 'keep me');
    return worktreePath;
  }

  it.each(['root', 'subdirectory', 'symlink'])(
    'preserves another configured project repository through its %s path',
    async (kind) => {
      const worktreePath = await worktree();
      let repoPath = worktreePath;
      if (kind === 'subdirectory') {
        repoPath = path.join(worktreePath, 'package');
        await mkdir(repoPath);
      } else if (kind === 'symlink') {
        repoPath = path.join(root, 'alias');
        await symlink(worktreePath, repoPath, 'dir');
      }
      projects.push({
        ...project,
        id: 'two',
        name: 'Two',
        repoPath,
        worktreeBasePath: path.join(root, 'other-worktrees'),
      });

      expect(await orphanedWorktreeService.findOrphanedWorktrees()).toEqual([]);
      expect(await orphanedWorktreeService.removeOrphanedWorktrees()).toEqual({
        removed: [],
        failed: [],
      });
      expect(await readFile(path.join(worktreePath, 'unsaved.txt'), 'utf8')).toBe('keep me');
    }
  );

  it.each(['unregistered', 'linked'])(
    'preserves nested repositories and their commits in a %s directory',
    async (kind) => {
      const candidate =
        kind === 'linked'
          ? await worktree()
          : path.join(project.worktreeBasePath, 'workspace-backup');
      const nested = path.join(candidate, 'nested');
      await initRepo(nested);
      const commit = await git(nested, 'rev-parse', 'HEAD');

      expect(await orphanedWorktreeService.findOrphanedWorktrees()).toEqual([]);
      await orphanedWorktreeService.removeOrphanedWorktrees();
      expect(await git(nested, 'rev-parse', 'HEAD')).toBe(commit);
    }
  );

  it('preserves nested bare repositories', async () => {
    const bare = path.join(project.worktreeBasePath, 'workspace-backup', 'backup.git');
    await git(project.repoPath, 'clone', '--bare', project.repoPath, bare);
    const commit = await git(bare, 'rev-parse', 'HEAD');
    expect(await orphanedWorktreeService.findOrphanedWorktrees()).toEqual([]);
    await orphanedWorktreeService.removeOrphanedWorktrees();
    expect(await git(bare, 'rev-parse', 'HEAD')).toBe(commit);
  });

  it.each([false, true])('uses the owner of a shared base (symlink alias: %s)', async (alias) => {
    const second = { ...project, id: 'two', name: 'Two', repoPath: path.join(root, 'repo-two') };
    await initRepo(second.repoPath);
    const candidate = await worktree(second);
    if (alias) {
      project.worktreeBasePath = path.join(root, 'base-alias');
      await symlink(second.worktreeBasePath, project.worktreeBasePath, 'dir');
    }
    projects.push(second);

    expect(await orphanedWorktreeService.findOrphanedWorktrees()).toEqual([
      { projectId: second.id, projectName: second.name, path: candidate },
    ]);
    expect(await orphanedWorktreeService.removeOrphanedWorktrees()).toEqual({
      removed: [candidate],
      failed: [],
    });
    await expect(readFile(path.join(candidate, 'unsaved.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await git(second.repoPath, 'worktree', 'list', '--porcelain')).not.toContain(candidate);
  });

  it('does not bypass a worktree lock through a different project sharing its base', async () => {
    const second = { ...project, id: 'two', name: 'Two', repoPath: path.join(root, 'repo-two') };
    await initRepo(second.repoPath);
    projects.push(second);
    const candidate = await worktree(second);
    await git(second.repoPath, 'worktree', 'lock', candidate);

    const result = await orphanedWorktreeService.removeOrphanedWorktrees();
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ path: candidate, error: expect.stringContaining('locked') }]);
    expect(await readFile(path.join(candidate, 'unsaved.txt'), 'utf8')).toBe('keep me');
  });

  it('preserves linked worktrees whose owning repository is not a configured project', async () => {
    const external = { ...project, repoPath: path.join(root, 'external') };
    await initRepo(external.repoPath);
    const candidate = await worktree(external);
    expect(await orphanedWorktreeService.findOrphanedWorktrees()).toEqual([]);
    await orphanedWorktreeService.removeOrphanedWorktrees();
    expect(await readFile(path.join(candidate, 'unsaved.txt'), 'utf8')).toBe('keep me');
  });

  it('still removes an ordinary unregistered leftover directory', async () => {
    const candidate = path.join(project.worktreeBasePath, 'workspace-deleted');
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, 'old.txt'), 'old work');
    expect(await orphanedWorktreeService.removeOrphanedWorktrees()).toEqual({
      removed: [candidate],
      failed: [],
    });
    await expect(readFile(path.join(candidate, 'old.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('deduplicates unregistered directories in a shared base', async () => {
    const candidate = path.join(project.worktreeBasePath, 'workspace-deleted');
    await mkdir(candidate, { recursive: true });
    projects.push({ ...project, id: 'two', name: 'Two' });
    expect(await orphanedWorktreeService.removeOrphanedWorktrees()).toEqual({
      removed: [candidate],
      failed: [],
    });
  });

  it('does not follow nested symlinks when checking or deleting a leftover', async () => {
    const candidate = path.join(project.worktreeBasePath, 'workspace-deleted');
    await mkdir(candidate, { recursive: true });
    await symlink(project.repoPath, path.join(candidate, 'external'), 'dir');
    const commit = await git(project.repoPath, 'rev-parse', 'HEAD');
    expect(await orphanedWorktreeService.removeOrphanedWorktrees()).toEqual({
      removed: [candidate],
      failed: [],
    });
    expect(await git(project.repoPath, 'rev-parse', 'HEAD')).toBe(commit);
  });

  it('skips a shared base if one project registration cannot be read', async () => {
    const candidate = await worktree();
    projects.push({ ...project, id: 'broken', repoPath: path.join(root, 'missing') });
    expect(await orphanedWorktreeService.findOrphanedWorktrees()).toEqual([]);
    await orphanedWorktreeService.removeOrphanedWorktrees();
    expect(await readFile(path.join(candidate, 'unsaved.txt'), 'utf8')).toBe('keep me');
  });
});
