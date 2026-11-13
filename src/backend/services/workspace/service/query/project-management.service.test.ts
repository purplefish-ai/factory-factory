import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { projectManagementService } from '@/backend/services/workspace/service/query/project-management.service';
import {
  inspectProjectRepository,
  validateRepositoryPath,
} from '@/backend/services/workspace/service/worktree/project-repository-inspector';

const { create, update, updateManyAndReturn } = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  updateManyAndReturn: vi.fn(),
}));
vi.mock('@/backend/db', () => ({ prisma: { project: { create, update, updateManyAndReturn } } }));
vi.mock('@/backend/services/workspace/service/worktree/project-repository-inspector', () => ({
  inspectProjectRepository: vi.fn(),
  validateRepositoryPath: vi.fn(),
}));

beforeEach(() => {
  create.mockReset().mockImplementation(async ({ data }) => ({ id: 'project', ...data }));
  update.mockReset().mockImplementation(async ({ data }) => ({ id: 'project', ...data }));
  updateManyAndReturn.mockReset().mockResolvedValue([]);
  vi.mocked(inspectProjectRepository)
    .mockReset()
    .mockResolvedValue({ githubOwner: null, githubRepo: null, defaultBranch: 'main' });
});

describe('project creation preparation', () => {
  it.each(['.', '/home/user/myrepo/.', '/', '/repos/---', '/repos/日本語'])(
    'rejects empty derived slug before inspection: %s',
    async (repoPath) => {
      await expect(
        projectManagementService.create({ repoPath }, { worktreeBaseDir: '/worktrees' })
      ).rejects.toThrow(
        `Unable to create project: repo path "${repoPath}" does not produce a valid slug`
      );
      expect(create).not.toHaveBeenCalled();
      expect(inspectProjectRepository).not.toHaveBeenCalled();
    }
  );

  it('persists inspected metadata and startup settings', async () => {
    vi.mocked(inspectProjectRepository).mockResolvedValue({
      githubOwner: 'org',
      githubRepo: 'demo',
      defaultBranch: 'release',
    });
    const project = await projectManagementService.create(
      { repoPath: '/repos/My_Project', startupScriptPath: 'start.sh', startupScriptTimeout: 0 },
      { worktreeBaseDir: '/worktrees' }
    );
    expect(project).toEqual({
      id: 'project',
      name: 'My Project',
      slug: 'my-project',
      repoPath: '/repos/My_Project',
      worktreeBasePath: '/worktrees/my-project',
      githubOwner: 'org',
      githubRepo: 'demo',
      defaultBranch: 'release',
      startupScriptCommand: null,
      startupScriptPath: 'start.sh',
      startupScriptTimeout: 0,
    });
  });

  it('allocates concurrent equal slugs with matching names and contained paths on every retry', async () => {
    const slugs = new Set<string>();
    create.mockImplementation(async ({ data }) => {
      await Promise.resolve();
      if (slugs.has(data.slug)) {
        throw new Error('Unique constraint failed on slug');
      }
      slugs.add(data.slug);
      return { id: data.slug, ...data };
    });
    const projects = await Promise.all(
      Array.from({ length: 3 }, () =>
        projectManagementService.create(
          { repoPath: '/repos/My_Project' },
          { worktreeBaseDir: '/worktrees' }
        )
      )
    );
    expect(projects.map((p) => [p.slug, p.name, p.worktreeBasePath])).toEqual([
      ['my-project', 'My Project', '/worktrees/my-project'],
      ['my-project-2', 'My Project 2', '/worktrees/my-project-2'],
      ['my-project-3', 'My Project 3', '/worktrees/my-project-3'],
    ]);
    for (const project of projects) {
      expect(path.relative('/worktrees', project.worktreeBasePath)).toBe(project.slug);
    }
    expect(inspectProjectRepository).toHaveBeenCalledTimes(3);
  });

  it('delegates path validation and preserves its result', async () => {
    vi.mocked(validateRepositoryPath).mockResolvedValue({
      valid: false,
      error: 'Path does not exist',
    });
    await expect(projectManagementService.validateRepoPath('/missing')).resolves.toEqual({
      valid: false,
      error: 'Path does not exist',
    });
    expect(validateRepositoryPath).toHaveBeenCalledWith('/missing');
  });
});

describe('project root restriction', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ff-project-root-')));
  mkdirSync(path.join(root, 'repo'));
  symlinkSync(path.join(root, 'repo'), path.join(root, 'alias'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('rejects a repository outside the configured root before validating it', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(root);
    vi.mocked(validateRepositoryPath).mockReset().mockResolvedValue({ valid: true });
    await expect(projectManagementService.validateRepoPath('/elsewhere/repo')).resolves.toEqual({
      valid: false,
      error: `Path /elsewhere/repo is outside the project root ${root}`,
    });
    expect(validateRepositoryPath).not.toHaveBeenCalled();
    await expect(
      projectManagementService.validateRepoPath(path.join(root, 'repo'))
    ).resolves.toEqual({ valid: true });
    expect(projectManagementService.checkProjectLocation('/elsewhere/clone')).toEqual({
      valid: false,
      error: `Path /elsewhere/clone is outside the project root ${root}`,
    });
  });

  it('validates and stores the real path it checked, not the string it was given', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(root);
    vi.mocked(validateRepositoryPath).mockReset().mockResolvedValue({ valid: true });
    const alias = path.join(root, 'alias');
    const real = path.join(root, 'repo');

    await projectManagementService.validateRepoPath(alias);
    expect(validateRepositoryPath).toHaveBeenCalledWith(real);

    const project = await projectManagementService.create(
      { repoPath: alias },
      { worktreeBaseDir: '/worktrees' }
    );
    expect(project).toMatchObject({ repoPath: real, slug: 'repo' });
    expect(inspectProjectRepository).toHaveBeenCalledWith(real);

    await projectManagementService.update('project', { repoPath: alias });
    expect(update).toHaveBeenCalledWith({ where: { id: 'project' }, data: { repoPath: real } });
    await projectManagementService.updateIfStartupUnchanged(
      'project',
      { startupScriptCommand: null, startupScriptPath: null },
      { repoPath: alias }
    );
    expect(updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ data: { repoPath: real } })
    );
  });

  it('refuses to store a path outside the root even when validation was skipped', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(root);
    await expect(
      projectManagementService.create({ repoPath: '/elsewhere/repo' }, { worktreeBaseDir: '/w' })
    ).rejects.toThrow(
      `Invalid repository path: Path /elsewhere/repo is outside the project root ${root}`
    );
    await expect(
      projectManagementService.update('project', { repoPath: '/elsewhere/repo' })
    ).rejects.toThrow(
      `Invalid repository path: Path /elsewhere/repo is outside the project root ${root}`
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('allows and stores any path as given when no root is configured', async () => {
    vi.spyOn(configService, 'getProjectRoot').mockReturnValue(null);
    vi.mocked(validateRepositoryPath).mockReset().mockResolvedValue({ valid: true });
    await expect(projectManagementService.validateRepoPath('/elsewhere/repo')).resolves.toEqual({
      valid: true,
    });
    expect(projectManagementService.checkProjectLocation('/elsewhere/clone')).toEqual({
      valid: true,
      path: '/elsewhere/clone',
    });
    const alias = path.join(root, 'alias');
    await expect(
      projectManagementService.create({ repoPath: alias }, { worktreeBaseDir: '/worktrees' })
    ).resolves.toMatchObject({ repoPath: alias, slug: 'alias' });
    await projectManagementService.update('project', { repoPath: alias });
    expect(update).toHaveBeenCalledWith({ where: { id: 'project' }, data: { repoPath: alias } });
  });
});
