import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecCommand = vi.fn();

vi.mock('@/backend/lib/shell', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
}));

import { checkGithubAuth } from './auth-check';
import { GH_TIMEOUT_MS } from './constants';

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

  it('bounds the auth status check with the health-check timeout', async () => {
    mockExecCommand.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: 'Logged in to github.com account octocat\n',
    });

    await checkGithubAuth();

    expect(mockExecCommand).toHaveBeenCalledWith('gh', ['auth', 'status'], {
      timeout: GH_TIMEOUT_MS.healthAuth,
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

  it.each([0, 1])('rejects an invalid or expired token with exit code %s', async (code) => {
    const output = [
      'github.com',
      '  X Failed to log in to github.com account detail-app[bot] (keyring)',
      '  - Active account: true',
      '  - The token in keyring is invalid.',
    ].join('\n');
    mockExecCommand.mockResolvedValue({ code, stdout: '', stderr: output });

    await expect(checkGithubAuth()).resolves.toEqual({ authenticated: false, error: output });
  });

  it.each(['', 'github.com\n  - Active account: true'])(
    'requires a successful login line even with exit code zero (%j)',
    async (output) => {
      mockExecCommand.mockResolvedValue({ code: 0, stdout: output, stderr: '' });

      await expect(checkGithubAuth()).resolves.toEqual({ authenticated: false, error: output });
    }
  );

  it.each([1, 2, 4, -1])('rejects successful-looking output with exit code %s', async (code) => {
    const output = 'Logged in to github.com account octocat\n';
    mockExecCommand.mockResolvedValue({ code, stdout: output, stderr: '' });

    await expect(checkGithubAuth()).resolves.toEqual({ authenticated: false, error: output });
  });

  it.each(['stdout', 'stderr'] as const)('accepts a valid login on %s', async (stream) => {
    mockExecCommand.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      [stream]: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n',
    });

    await expect(checkGithubAuth()).resolves.toEqual({ authenticated: true, user: 'octocat' });
  });

  it.each([false, true])(
    'rejects mixed valid and invalid accounts (failure first: %s)',
    async (failureFirst) => {
      const success = '  ✓ Logged in to github.com account octocat (keyring)\n';
      const failure = '  X Failed to log in to github.com account expired-user (keyring)\n';
      const output = failureFirst ? failure + success : success + failure;
      mockExecCommand.mockResolvedValue({ code: 0, stdout: '', stderr: output });

      await expect(checkGithubAuth()).resolves.toEqual({ authenticated: false, error: output });
    }
  );

  it.each([false, true])(
    'checks both output streams (failure on stdout: %s)',
    async (failureOnStdout) => {
      const success = '  ✓ Logged in to github.com account octocat (keyring)';
      const failure = '  X Failed to log in to github.com account expired-user (keyring)';
      const stdout = failureOnStdout ? failure : success;
      const stderr = failureOnStdout ? success : failure;
      mockExecCommand.mockResolvedValue({ code: 0, stdout, stderr });

      await expect(checkGithubAuth()).resolves.toEqual({
        authenticated: false,
        error: `${stderr}\n${stdout}`,
      });
    }
  );

  it('accepts valid login output even when stderr contains a warning', async () => {
    mockExecCommand.mockResolvedValue({
      code: 0,
      stdout: 'Logged in to github.com account octocat\n',
      stderr: 'Warning: a new gh version is available',
    });

    await expect(checkGithubAuth()).resolves.toEqual({ authenticated: true, user: 'octocat' });
  });

  it('accepts multiple valid accounts', async () => {
    mockExecCommand.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: [
        '  ✓ Logged in to github.com account octocat (keyring)',
        '  - Active account: true',
        '  ✓ Logged in to github.com account second-user (keyring)',
        '  - Active account: false',
      ].join('\n'),
    });

    await expect(checkGithubAuth()).resolves.toEqual({ authenticated: true, user: 'octocat' });
  });

  it.each(['stdout', 'stderr'] as const)(
    'accepts legacy successful login wording on %s',
    async (stream) => {
      mockExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: '',
        [stream]: 'github.com\n  ✓ Logged in to github.com as octocat (keyring)\n',
      });

      await expect(checkGithubAuth()).resolves.toEqual({ authenticated: true, user: 'octocat' });
    }
  );
});
