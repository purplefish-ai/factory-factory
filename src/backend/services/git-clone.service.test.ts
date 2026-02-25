import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPathExists = vi.fn();
const mockGitCommand = vi.fn();

vi.mock('@/backend/lib/file-helpers', () => ({
  pathExists: (...args: unknown[]) => mockPathExists(...args),
}));

vi.mock('@/backend/lib/shell', () => ({
  execCommand: vi.fn(),
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { gitCloneService, parseGithubUrl } from './git-clone.service';

describe('parseGithubUrl', () => {
  it('parses a valid GitHub URL', () => {
    expect(parseGithubUrl('https://github.com/purplefish-ai/factory-factory')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
  });

  it('parses a valid GitHub URL with .git suffix', () => {
    expect(parseGithubUrl('https://github.com/purplefish-ai/factory-factory.git')).toEqual({
      owner: 'purplefish-ai',
      repo: 'factory-factory',
    });
  });

  it('rejects traversal owner path segment', () => {
    expect(parseGithubUrl('https://github.com/../src')).toBeNull();
  });

  it('rejects traversal repo path segment', () => {
    expect(parseGithubUrl('https://github.com/purplefish-ai/..')).toBeNull();
  });

  it('rejects dot-only segments', () => {
    expect(parseGithubUrl('https://github.com/./repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/.')).toBeNull();
  });

  it('rejects invalid characters in owner/repo segments', () => {
    expect(parseGithubUrl('https://github.com/owner name/repo')).toBeNull();
    expect(parseGithubUrl('https://github.com/owner/repo name')).toBeNull();
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
