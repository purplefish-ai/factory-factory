import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecCommand = vi.fn();

vi.mock('@/backend/lib/shell', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
}));

import { checkGithubAuth } from './auth-check';

describe('checkGithubAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the authenticated username on success', async () => {
    mockExecCommand.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: 'Logged in to github.com account octocat\n',
    });

    await expect(checkGithubAuth()).resolves.toEqual({
      authenticated: true,
      user: 'octocat',
    });
  });

  it('reports not authenticated when gh auth status exits non-zero', async () => {
    mockExecCommand.mockResolvedValue({ code: 1, stdout: '', stderr: 'not logged in' });

    await expect(checkGithubAuth()).resolves.toEqual({
      authenticated: false,
      error: 'not logged in',
    });
  });

  it('reports gh CLI as not installed', async () => {
    mockExecCommand.mockRejectedValue(new Error('spawn gh ENOENT'));

    await expect(checkGithubAuth()).resolves.toEqual({
      authenticated: false,
      error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
    });
  });
});
