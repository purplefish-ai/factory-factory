import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCommandC } from '@/backend/lib/shell';
import {
  inspectProjectRepository,
  parseGitHubRemoteUrl,
  validateRepositoryPath,
} from '@/backend/services/workspace/service/worktree/project-repository-inspector';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

function mockValidationExit(code: number, stderr = '') {
  mockSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  });
}

vi.mock('node:fs/promises', () => ({ access: vi.fn(), constants: { R_OK: 4 } }));
vi.mock('@/backend/lib/shell', () => ({ gitCommandC: vi.fn() }));

beforeEach(() => {
  vi.mocked(access).mockResolvedValue(undefined);
  mockSpawn.mockReset();
  mockValidationExit(0);
  vi.mocked(gitCommandC).mockReset().mockResolvedValue({ code: 1, stdout: '', stderr: '' });
});

describe('repository inspection', () => {
  it('prefers origin HEAD and parses its GitHub remote', async () => {
    vi.mocked(gitCommandC)
      .mockResolvedValueOnce({ code: 0, stdout: 'git@github.com:org/repo.git\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'origin/release\n', stderr: '' });
    await expect(inspectProjectRepository('/repo')).resolves.toEqual({
      githubOwner: 'org',
      githubRepo: 'repo',
      defaultBranch: 'release',
    });
    expect(gitCommandC).toHaveBeenCalledTimes(2);
  });

  it.each(['origin/HEAD', 'origin/', '', 'origin/develop'])(
    'falls back to local HEAD for unusable origin result %s',
    async (stdout) => {
      vi.mocked(gitCommandC)
        .mockRejectedValueOnce(new Error('no origin'))
        .mockResolvedValueOnce({ code: stdout === 'origin/develop' ? 1 : 0, stdout, stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: 'local-branch\n', stderr: '' });
      await expect(inspectProjectRepository('/repo')).resolves.toEqual({
        githubOwner: null,
        githubRepo: null,
        defaultBranch: 'local-branch',
      });
    }
  );

  it('keeps main when Git commands throw or local HEAD is empty', async () => {
    vi.mocked(gitCommandC)
      .mockRejectedValueOnce(new Error('remote failure'))
      .mockRejectedValueOnce(new Error('HEAD failure'));
    await expect(inspectProjectRepository('/repo')).resolves.toEqual({
      githubOwner: null,
      githubRepo: null,
      defaultBranch: 'main',
    });
  });
});

describe('repository path validation', () => {
  it('checks readability then passes the full path as one Git argument', async () => {
    vi.mocked(gitCommandC).mockResolvedValue({ code: 0, stdout: '.git', stderr: '' });
    await expect(validateRepositoryPath('/repo with spaces; echo hi')).resolves.toEqual({
      valid: true,
    });
    expect(access).toHaveBeenCalledWith('/repo with spaces; echo hi', 4);
    expect(mockSpawn).toHaveBeenCalledWith('git', [
      '-C',
      '/repo with spaces; echo hi',
      'rev-parse',
      '--git-dir',
    ]);
  });

  it.each([
    ['ENOENT: no such file', 'Path does not exist'],
    ['EACCES: permission denied', 'Path is not accessible'],
    ['unexpected failure', 'unexpected failure'],
  ])('preserves filesystem error %s', async (message, error) => {
    vi.mocked(access).mockRejectedValueOnce(new Error(message));
    await expect(validateRepositoryPath('/repo')).resolves.toEqual({ valid: false, error });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('preserves nonzero-exit and process-spawn error messages', async () => {
    mockValidationExit(17);
    await expect(validateRepositoryPath('/repo')).resolves.toEqual({
      valid: false,
      error: 'Command exited with code 17',
    });
    mockSpawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit('error', new Error('spawn git ENOENT')));
      return child;
    });
    await expect(validateRepositoryPath('/repo')).resolves.toEqual({
      valid: false,
      error: 'Path does not exist',
    });
  });

  it('maps Git failure and unknown errors', async () => {
    mockValidationExit(128, 'fatal: not a git repository');
    await expect(validateRepositoryPath('/repo')).resolves.toEqual({
      valid: false,
      error: 'Path is not a git repository',
    });
    vi.mocked(access).mockRejectedValueOnce('not an Error');
    await expect(validateRepositoryPath('/repo')).resolves.toEqual({
      valid: false,
      error: 'Unknown error',
    });
  });
});

describe('parseGitHubRemoteUrl', () => {
  describe('SSH URLs', () => {
    it('should parse standard SSH URL with .git suffix', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse SSH URL without .git suffix', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/repo');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should handle organization names with hyphens', () => {
      const result = parseGitHubRemoteUrl('git@github.com:my-org/my-repo.git');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
    });

    it('should handle repo names with dots', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/repo.name.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo.name' });
    });

    it('should handle repo names with underscores', () => {
      const result = parseGitHubRemoteUrl('git@github.com:owner/my_repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'my_repo' });
    });
  });

  describe('HTTPS URLs', () => {
    it('should parse standard HTTPS URL with .git suffix', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse HTTPS URL without .git suffix', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse HTTP URL (not HTTPS)', () => {
      const result = parseGitHubRemoteUrl('http://github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should handle organization names with hyphens', () => {
      const result = parseGitHubRemoteUrl('https://github.com/my-org/my-repo.git');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
    });

    it('should handle repo names with dots', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo.name.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo.name' });
    });
  });

  describe('Non-GitHub URLs', () => {
    it('should return null for GitLab SSH URL', () => {
      const result = parseGitHubRemoteUrl('git@gitlab.com:owner/repo.git');
      expect(result).toBeNull();
    });

    it('should return null for GitLab HTTPS URL', () => {
      const result = parseGitHubRemoteUrl('https://gitlab.com/owner/repo.git');
      expect(result).toBeNull();
    });

    it('should return null for Bitbucket URL', () => {
      const result = parseGitHubRemoteUrl('git@bitbucket.org:owner/repo.git');
      expect(result).toBeNull();
    });

    it('should return null for self-hosted Git URL', () => {
      const result = parseGitHubRemoteUrl('git@git.company.com:owner/repo.git');
      expect(result).toBeNull();
    });
  });

  describe('Invalid URLs', () => {
    it('should return null for empty string', () => {
      const result = parseGitHubRemoteUrl('');
      expect(result).toBeNull();
    });

    it('should return null for malformed URL', () => {
      const result = parseGitHubRemoteUrl('not-a-url');
      expect(result).toBeNull();
    });

    it('should return null for URL without repo', () => {
      const result = parseGitHubRemoteUrl('https://github.com/owner');
      expect(result).toBeNull();
    });

    it('should return null for URL with extra path segments', () => {
      // This is technically valid GitHub URL structure but we only want owner/repo
      const result = parseGitHubRemoteUrl('https://github.com/owner/repo/tree/main');
      expect(result).toBeNull();
    });
  });
});
