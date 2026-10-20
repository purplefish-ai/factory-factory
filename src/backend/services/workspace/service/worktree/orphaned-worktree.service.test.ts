import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gitOpsService } from './git-ops.service';
import { orphanedWorktreeService } from './orphaned-worktree.service';

describe('orphanedWorktreeService', () => {
  let tempRoot: string;
  let worktreeBasePath: string;
  let project: { id: string; name: string; repoPath: string; worktreeBasePath: string };

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempRoot = await mkdtemp(path.join(tmpdir(), 'ff-orphaned-worktrees-'));
    worktreeBasePath = path.join(tempRoot, 'worktrees');
    project = {
      id: 'project-1',
      name: 'Project One',
      repoPath: path.join(tempRoot, 'repo'),
      worktreeBasePath,
    };
    vi.spyOn(projectAccessor, 'list').mockResolvedValue(
      unsafeCoerce<Awaited<ReturnType<typeof projectAccessor.list>>>([project])
    );
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('reports only app-created worktrees that no non-archived workspace owns', async () => {
    await mkdir(path.join(worktreeBasePath, 'workspace-archived'), { recursive: true });
    await mkdir(path.join(worktreeBasePath, 'workspace-active'));
    await mkdir(path.join(worktreeBasePath, 'workspace-provisioning'));
    await mkdir(path.join(worktreeBasePath, 'workspace-custom-path'));
    await mkdir(path.join(worktreeBasePath, 'unrelated-folder'));
    await writeFile(path.join(worktreeBasePath, 'workspace-file'), '');
    await symlink(
      path.join(worktreeBasePath, 'unrelated-folder'),
      path.join(worktreeBasePath, 'workspace-link'),
      'dir'
    );
    vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs').mockResolvedValue([
      { id: 'active', worktreePath: path.join(worktreeBasePath, 'workspace-active') },
      { id: 'provisioning', worktreePath: null },
      { id: 'other', worktreePath: path.join(worktreeBasePath, 'workspace-custom-path') },
    ]);

    await expect(orphanedWorktreeService.findOrphanedWorktrees()).resolves.toEqual([
      {
        projectId: 'project-1',
        projectName: 'Project One',
        path: path.join(worktreeBasePath, 'workspace-archived'),
      },
    ]);
  });

  it('never reports standalone repositories, which may hold unique commits', async () => {
    await mkdir(path.join(worktreeBasePath, 'workspace-standalone', '.git'), { recursive: true });
    await mkdir(path.join(worktreeBasePath, 'workspace-linked'));
    await writeFile(path.join(worktreeBasePath, 'workspace-linked', '.git'), 'gitdir: /repo');
    vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs').mockResolvedValue([]);

    await expect(orphanedWorktreeService.findOrphanedWorktrees()).resolves.toEqual([
      expect.objectContaining({ path: path.join(worktreeBasePath, 'workspace-linked') }),
    ]);
  });

  it('keeps scanning other projects when one worktree base is unreadable', async () => {
    const brokenBase = path.join(tempRoot, 'not-a-directory');
    await writeFile(brokenBase, '');
    await mkdir(path.join(worktreeBasePath, 'workspace-orphan'), { recursive: true });
    vi.spyOn(projectAccessor, 'list').mockResolvedValue(
      unsafeCoerce<Awaited<ReturnType<typeof projectAccessor.list>>>([
        { ...project, id: 'broken', worktreeBasePath: brokenBase },
        project,
      ])
    );
    vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs').mockResolvedValue([]);

    await expect(orphanedWorktreeService.findOrphanedWorktrees()).resolves.toEqual([
      expect.objectContaining({
        projectId: 'project-1',
        path: path.join(worktreeBasePath, 'workspace-orphan'),
      }),
    ]);
  });

  it('skips projects whose worktree base does not exist', async () => {
    const refsSpy = vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs');

    await expect(orphanedWorktreeService.findOrphanedWorktrees()).resolves.toEqual([]);
    expect(refsSpy).not.toHaveBeenCalled();
  });

  it('removes orphans through git and reports failures without stopping', async () => {
    const first = path.join(worktreeBasePath, 'workspace-first');
    const second = path.join(worktreeBasePath, 'workspace-second');
    await mkdir(first, { recursive: true });
    await mkdir(second);
    vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs').mockResolvedValue([]);
    const removeSpy = vi
      .spyOn(gitOpsService, 'removeWorktree')
      .mockImplementation((worktreePath) =>
        worktreePath === first ? Promise.reject(new Error('locked')) : Promise.resolve()
      );

    const result = await orphanedWorktreeService.removeOrphanedWorktrees();

    expect(removeSpy).toHaveBeenCalledWith(first, project);
    expect(removeSpy).toHaveBeenCalledWith(second, project);
    expect(result).toEqual({ removed: [second], failed: [{ path: first, error: 'locked' }] });
  });

  it('shares one in-flight cleanup between concurrent callers', async () => {
    await mkdir(path.join(worktreeBasePath, 'workspace-orphan'), { recursive: true });
    vi.spyOn(workspaceAccessor, 'findNonArchivedWorktreeRefs').mockResolvedValue([]);
    const removeSpy = vi.spyOn(gitOpsService, 'removeWorktree').mockResolvedValue(undefined);

    const [a, b] = await Promise.all([
      orphanedWorktreeService.removeOrphanedWorktrees(),
      orphanedWorktreeService.removeOrphanedWorktrees(),
    ]);

    expect(a).toBe(b);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
