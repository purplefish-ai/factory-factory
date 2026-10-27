import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectManagementService } from '@/backend/services/workspace/service/query/project-management.service';
import {
  inspectProjectRepository,
  validateRepositoryPath,
} from '@/backend/services/workspace/service/worktree/project-repository-inspector';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/backend/db', () => ({ prisma: { project: { create } } }));
vi.mock('@/backend/services/workspace/service/worktree/project-repository-inspector', () => ({
  inspectProjectRepository: vi.fn(),
  validateRepositoryPath: vi.fn(),
}));

beforeEach(() => {
  create.mockReset().mockImplementation(async ({ data }) => ({ id: 'project', ...data }));
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
