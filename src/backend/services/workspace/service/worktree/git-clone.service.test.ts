import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPathExists = vi.fn();
const mockMkdir = vi.fn();
const mockRm = vi.fn();
const mockReaddir = vi.fn();
const mockExecCommand = vi.fn();
const mockGitCommand = vi.fn();

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
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

describe('GitCloneService.getClonePath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPathExists.mockResolvedValue(true);
    // Simulate Linux, where multiple differently cased owner paths can coexist.
    mockReaddir.mockImplementation((path: string) => {
      if (path === '/repos') {
        return Promise.resolve(['owner', 'OWNER', 'unrelated']);
      }
      return Promise.resolve(['RePo', 'repo']);
    });
    mockGitCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  });

  it('prefers an existing canonical clone when multiple case variants exist', async () => {
    await expect(gitCloneService.getClonePath('/repos', 'OwNeR', 'RePo')).resolves.toEqual({
      path: '/repos/owner/repo',
      status: 'valid_repo',
    });
    expect(mockReaddir).not.toHaveBeenCalledWith('/repos/unrelated');
    expect(mockGitCommand).toHaveBeenCalledTimes(2);
  });

  it('searches all owner variants for a valid clone before rejecting non-repos', async () => {
    mockGitCommand.mockImplementation(async (_args: string[], path: string) => ({
      code: path === '/repos/owner/RePo' ? 0 : 128,
      stdout: '',
      stderr: '',
    }));
    await expect(gitCloneService.getClonePath('/repos', 'OWNER', 'REPO')).resolves.toEqual({
      path: '/repos/owner/RePo',
      status: 'valid_repo',
    });
  });

  it('returns the first conflicting path and its existing non-repository status', async () => {
    mockGitCommand.mockResolvedValue({ code: 128, stdout: '', stderr: '' });
    await expect(gitCloneService.getClonePath('/repos', 'OWNER', 'REPO')).resolves.toEqual({
      path: '/repos/owner/repo',
      status: 'not_repo',
    });
    expect(mockGitCommand).toHaveBeenCalledTimes(4);
  });

  it('returns a new canonical destination without spawning git', async () => {
    mockReaddir.mockResolvedValue([]);
    mockPathExists.mockResolvedValue(false);
    await expect(gitCloneService.getClonePath('/repos', 'OWNER', 'REPO')).resolves.toEqual({
      path: '/repos/owner/repo',
      status: 'not_exists',
    });
    expect(mockGitCommand).not.toHaveBeenCalled();
  });

  it('keeps the selected first candidate status when later candidates disappeared', async () => {
    mockPathExists.mockImplementation(async (path: string) => path === '/repos/owner/repo');
    mockGitCommand.mockResolvedValue({ code: 128, stdout: '', stderr: '' });
    await expect(gitCloneService.getClonePath('/repos', 'OWNER', 'REPO')).resolves.toEqual({
      path: '/repos/owner/repo',
      status: 'not_repo',
    });
    expect(mockGitCommand).toHaveBeenCalledTimes(1);
  });

  it('checks the canonical path even when the scan found no candidates', async () => {
    mockReaddir.mockResolvedValue([]);
    mockGitCommand.mockResolvedValue({ code: 128, stdout: '', stderr: '' });
    await expect(gitCloneService.getClonePath('/repos', 'OWNER', 'REPO')).resolves.toEqual({
      path: '/repos/owner/repo',
      status: 'not_repo',
    });
    expect(mockPathExists).toHaveBeenCalledWith('/repos/owner/repo');
  });

  it.each(['/repos', '/repos/owner'])(
    'propagates directory access errors at %s instead of choosing another clone path',
    async (deniedPath) => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      mockReaddir.mockImplementation((path: string) => {
        if (path === deniedPath) {
          return Promise.reject(error);
        }
        return Promise.resolve(['owner']);
      });
      await expect(gitCloneService.getClonePath('/repos', 'owner', 'repo')).rejects.toBe(error);
    }
  );
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
    mockGitCommand.mockResolvedValue({ code: 128, stdout: '', stderr: '' });
  });

  it('shares concurrent clones to the same normalized destination without removing the winner', async () => {
    const completed = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
    mockExecCommand
      .mockImplementationOnce(() => completed.promise)
      .mockResolvedValue({
        code: 128,
        stdout: '',
        stderr: 'fatal: destination path already exists',
      });
    mockPathExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const first = gitCloneService.clone('source', '/tmp/repos/owner/repo');
    const second = gitCloneService.clone('source', '/tmp/repos/owner/./repo');
    await vi.waitFor(() => expect(mockExecCommand).toHaveBeenCalled());
    completed.resolve({ code: 0, stdout: '', stderr: 'Cloned' });
    expect(await Promise.all([first, second])).toEqual([
      { success: true, output: 'Cloned' },
      { success: true, output: 'Cloned' },
    ]);
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('waits for an in-flight clone before inspecting its destination for another import', async () => {
    const completed = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
    mockExecCommand.mockImplementation(() => completed.promise);
    mockReaddir.mockResolvedValue([]);
    const clone = gitCloneService.clone('source', '/repos/owner/repo');
    await vi.waitFor(() => expect(mockExecCommand).toHaveBeenCalledTimes(1));
    mockPathExists.mockResolvedValue(true);
    let completedScan = false;
    const scan = gitCloneService.getClonePath('/repos', 'OWNER', 'REPO').then((result) => {
      completedScan = true;
      return result;
    });
    // Flush queued filesystem and git promises without completing the clone.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    const inspectedBeforeCloneCompleted = completedScan;
    mockGitCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    completed.resolve({ code: 0, stdout: '', stderr: '' });
    await clone;
    expect(inspectedBeforeCloneCompleted).toBe(false);
    expect(await scan).toEqual({ path: '/repos/owner/repo', status: 'valid_repo' });
  });

  it('clones different destinations concurrently', async () => {
    const completed = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
    mockExecCommand.mockImplementation(() => completed.promise);
    const first = gitCloneService.clone('source-a', '/tmp/clone-a');
    const second = gitCloneService.clone('source-b', '/tmp/clone-b');
    await vi.waitFor(() => expect(mockExecCommand).toHaveBeenCalledTimes(2));
    completed.resolve({ code: 0, stdout: '', stderr: '' });
    expect(await Promise.all([first, second])).toEqual([
      { success: true, output: '' },
      { success: true, output: '' },
    ]);
  });

  it('allows retry after a shared clone fails', async () => {
    const completed = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
    mockExecCommand.mockImplementation(() => completed.promise);
    const first = gitCloneService.clone('source', '/tmp/retry-clone');
    const second = gitCloneService.clone('source', '/tmp/retry-clone');
    await vi.waitFor(() => expect(mockExecCommand).toHaveBeenCalled());
    completed.resolve({ code: 128, stdout: '', stderr: 'network failure' });
    expect(await Promise.all([first, second])).toEqual([
      { success: false, output: 'network failure', error: 'network failure' },
      { success: false, output: 'network failure', error: 'network failure' },
    ]);
    mockExecCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    expect(await gitCloneService.clone('source', '/tmp/retry-clone')).toEqual({
      success: true,
      output: '',
    });
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it('reuses a completed repository when another caller resolved a stale missing destination', async () => {
    mockPathExists.mockResolvedValue(true);
    mockGitCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    mockExecCommand.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'destination already exists',
    });
    expect(await gitCloneService.clone('source', '/tmp/completed-clone')).toMatchObject({
      success: true,
    });
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('never cleans up a valid repository observed after a clone failure', async () => {
    mockPathExists.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockGitCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    mockExecCommand.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'destination already exists',
    });
    await gitCloneService.clone('source', '/tmp/concurrent-repo');
    expect(mockRm).not.toHaveBeenCalled();
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
