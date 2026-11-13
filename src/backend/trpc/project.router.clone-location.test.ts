import { describe, expect, it, vi } from 'vitest';
import { projectRouter } from './project.trpc';

describe('projectRouter.createFromGithub with a project root', () => {
  it('refuses a clone destination outside the project root before cloning', async () => {
    const clone = vi.fn();
    const create = vi.fn();
    const checkProjectLocation = vi.fn(() => ({
      valid: false,
      error: 'Path /repos/org/new-repo is outside the project root /sandbox',
    }));
    const caller = projectRouter.createCaller({
      appContext: {
        services: {
          configService: {
            getReposDir: () => '/repos',
            getWorktreeBaseDir: () => '/tmp/worktrees',
            getCorsConfig: () => ({ allowedOrigins: [] }),
          },
          gitCloneService: {
            getClonePath: () =>
              Promise.resolve({ path: '/repos/org/new-repo', status: 'not_exists' }),
            clone,
          },
          projectManagementService: { checkProjectLocation, validateRepoPath: vi.fn(), create },
        },
      },
    } as never);

    await expect(
      caller.createFromGithub({ githubUrl: 'https://github.com/org/new-repo' })
    ).rejects.toThrow(
      'Invalid repository path: Path /repos/org/new-repo is outside the project root /sandbox'
    );
    expect(checkProjectLocation).toHaveBeenCalledWith('/repos/org/new-repo');
    expect(clone).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
