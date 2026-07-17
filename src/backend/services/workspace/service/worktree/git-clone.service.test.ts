import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPathExists = vi.fn();
const mockMkdir = vi.fn();
const mockRm = vi.fn();
const mockExecCommand = vi.fn();
const mockGitCommand = vi.fn();

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

vi.mock('@/backend/lib/file-helpers', () => ({
  pathExists: (...args: unknown[]) => mockPathExists(...args),
}));

vi.mock('@/backend/lib/shell', () => ({
  execCommand: (...args: unknown[]) => mockExecCommand(...args),
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { gitCloneService, parseGithubUrl } from './git-clone.service';

describe('parseGithubUrl', () => {
  it('parses a valid GitHub HTTPS URL', () => {
    expect(parseGithubUrl('https://github.com/purplefish-ai/factory-factory')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
  });

  it('parses a valid GitHub HTTPS URL with .git suffix', () => {
    expect(parseGithubUrl('https://github.com/purplefish-ai/factory-factory.git')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
  });

  it('parses a valid GitHub SSH URL', () => {
    expect(parseGithubUrl('git@github.com:purplefish-ai/factory-factory')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
  });

  it('parses a valid GitHub SSH URL with .git suffix', () => {
    expect(parseGithubUrl('git@github.com:purplefish-ai/factory-factory.git')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
  });

  it('parses a valid GitHub SSH URL with trailing slash', () => {
    expect(parseGithubUrl('git@github.com:purplefish-ai/factory-factory-cloud.git/')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory-cloud',
    });
  });

  it('rejects traversal owner path segment in HTTPS URL', () => {
    expect(parseGithubUrl('https://github.com/../src')).toBeNull();
  });

  it('rejects traversal repo path segment in HTTPS URL', () => {
    expect(parseGithubUrl('https://github.com/purplefish-ai/..')).toBeNull();
  });

  it('rejects traversal owner path segment in SSH URL', () => {
    expect(parseGithubUrl('git@github.com:../src')).toBeNull();
  });

  it('rejects traversal repo path segment in SSH URL', () => {
    expect(parseGithubUrl('git@github.com:purplefish-ai/..')).toBeNull();
  });

  it('rejects dot-only segments in HTTPS URL', () => {
    expect(parseGithubUrl('https://github.com/./repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/.')).toBeNull();
  });

  it('rejects dot-only segments in SSH URL', () => {
    expect(parseGithubUrl('git@github.com:./repo')).toBeNull();
    expect(parseGithubUrl('git@github.com:owner/.')).toBeNull();
  });

  it('rejects invalid characters in owner/repo segments in HTTPS URL', () => {
    expect(parseGithubUrl('https://github.com/owner name/repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/repo name')).toBeNull();
  });

  it('rejects invalid characters in owner/repo segments in SSH URL', () => {
    expect(parseGithubUrl('git@github.com:owner name/repo')).toBeNull();
    expect(parseGithubUrl('git@github.com:owner/repo name')).toBeNull();
  });
});

describe('GitCloneService.checkExistingClone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_exists when clone directory does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(gitCloneService.checkExistingClone('/tmp/repos/owner/repo')).resolves.toBe(
      'not_exists'
    );
    expect(mockGitCommand).not.toHaveBeenCalled();
  });

  it('returns not_repo when directory exists but is not a git repository', async () => {
    mockPathExists.mockResolvedValue(true);
    mockGitCommand.mockResolvedValueOnce({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repo',
    });

    await expect(gitCloneService.checkExistingClone('/tmp/repos/owner/repo')).resolves.toBe(
      'not_repo'
    );
  });

  it('returns valid_repo only when clone path is repository root', async () => {
    mockPathExists.mockResolvedValue(true);
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '\n', stderr: '' });

    await expect(gitCloneService.checkExistingClone('/tmp/repos/owner/repo')).resolves.toBe(
      'valid_repo'
    );
    expect(mockGitCommand).toHaveBeenNthCalledWith(
      1,
      ['rev-parse', '--git-dir'],
      '/tmp/repos/owner/repo'
    );
    expect(mockGitCommand).toHaveBeenNthCalledWith(
      2,
      ['rev-parse', '--show-cdup'],
      '/tmp/repos/owner/repo'
    );
  });

  it('returns not_repo when clone path is nested inside another repository', async () => {
    mockPathExists.mockResolvedValue(true);
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '.git\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '../\n', stderr: '' });

    await expect(gitCloneService.checkExistingClone('/tmp/source-tree/src')).resolves.toBe(
      'not_repo'
    );
  });
});

describe('GitCloneService.clone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockPathExists.mockResolvedValue(false);
  });

  it('runs git clone with a timeout and non-interactive prompts disabled', async () => {
    mockExecCommand.mockResolvedValue({ code: 0, stdout: '', stderr: 'Receiving objects' });

    await expect(
      gitCloneService.clone(
        'https://github.com/purplefish-ai/factory-factory',
        '/tmp/repos/purplefish-ai/factory-factory'
      )
    ).resolves.toEqual({ success: true, output: 'Receiving objects' });

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/repos/purplefish-ai', { recursive: true });
    expect(mockExecCommand).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--progress',
        'https://github.com/purplefish-ai/factory-factory',
        '/tmp/repos/purplefish-ai/factory-factory',
      ],
      expect.objectContaining({
        timeout: 600_000,
        env: expect.objectContaining({
          GCM_INTERACTIVE: 'never',
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: expect.stringContaining('BatchMode=yes'),
        }),
      })
    );
  });

  it('cleans up a failed partial clone destination that did not exist before cloning', async () => {
    mockPathExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockExecCommand.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'fatal: remote end hung up unexpectedly',
    });

    await expect(
      gitCloneService.clone(
        'https://github.com/purplefish-ai/factory-factory',
        '/tmp/repos/purplefish-ai/factory-factory'
      )
    ).resolves.toEqual({
      success: false,
      output: 'fatal: remote end hung up unexpectedly',
      error: 'fatal: remote end hung up unexpectedly',
    });

    expect(mockRm).toHaveBeenCalledWith('/tmp/repos/purplefish-ai/factory-factory', {
      recursive: true,
      force: true,
    });
  });

  it('does not remove a destination that existed before a failed clone attempt', async () => {
    mockPathExists.mockResolvedValue(true);
    mockExecCommand.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'fatal: destination path already exists',
    });

    await expect(
      gitCloneService.clone(
        'https://github.com/purplefish-ai/factory-factory',
        '/tmp/repos/purplefish-ai/factory-factory'
      )
    ).resolves.toMatchObject({
      success: false,
      error: 'fatal: destination path already exists',
    });

    expect(mockRm).not.toHaveBeenCalled();
  });

  it('returns a clear error when git clone times out', async () => {
    mockPathExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockExecCommand.mockResolvedValue({
      code: -1,
      stdout: '',
      stderr: 'git timed out after 600000ms',
      timedOut: true,
    });

    await expect(
      gitCloneService.clone(
        'https://github.com/purplefish-ai/factory-factory',
        '/tmp/repos/purplefish-ai/factory-factory'
      )
    ).resolves.toMatchObject({
      success: false,
      error: 'Clone timed out after 600 seconds',
    });

    expect(mockRm).toHaveBeenCalledWith('/tmp/repos/purplefish-ai/factory-factory', {
      recursive: true,
      force: true,
    });
  });
});
