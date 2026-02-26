import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkspaceDataService = vi.hoisted(() => ({
  findByIdWithProject: vi.fn(),
}));
const mockGetWorkspaceWithWorktree = vi.hoisted(() => vi.fn());
const mockGetWorkspaceWithProjectAndWorktreeOrThrow = vi.hoisted(() => vi.fn());
const mockGitCommand = vi.hoisted(() => vi.fn());
const mockGetMergeBase = vi.hoisted(() => vi.fn());
const mockIsPathSafe = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/backend/domains/workspace', () => ({
  workspaceDataService: mockWorkspaceDataService,
}));

vi.mock('./workspace-helpers', () => ({
  getWorkspaceWithWorktree: (...args: unknown[]) => mockGetWorkspaceWithWorktree(...args),
  getWorkspaceWithProjectAndWorktreeOrThrow: (...args: unknown[]) =>
    mockGetWorkspaceWithProjectAndWorktreeOrThrow(...args),
}));

vi.mock('@/backend/lib/shell', () => ({
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

vi.mock('@/backend/lib/file-helpers', () => ({
  isPathSafe: mockIsPathSafe,
}));

vi.mock('@/backend/lib/git-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/git-helpers')>();
  return {
    ...actual,
    getMergeBase: (...args: unknown[]) => mockGetMergeBase(...args),
  };
});

import { workspaceGitRouter } from './git.trpc';

function createCaller() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return workspaceGitRouter.createCaller({
    appContext: {
      services: {
        createLogger: () => logger,
      },
    },
  } as never);
}

describe('workspaceGitRouter', () => {
  let rootDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    rootDir = join(tmpdir(), `workspace-git-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns empty status when workspace has no worktree', async () => {
    mockGetWorkspaceWithWorktree.mockResolvedValue(null);
    const caller = createCaller();
    await expect(caller.getGitStatus({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
      hasUncommitted: false,
    });
  });

  it('throws when git status fails and handles empty unstaged workspace result', async () => {
    const caller = createCaller();
    mockGetWorkspaceWithWorktree.mockResolvedValueOnce({
      workspace: { id: 'w1' },
      worktreePath: '/repo',
    });
    mockGitCommand.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'fatal',
    });

    await expect(caller.getGitStatus({ workspaceId: 'w1' })).rejects.toThrow(
      'Git status failed: fatal'
    );

    mockGetWorkspaceWithWorktree.mockResolvedValueOnce(null);
    await expect(caller.getUnstagedChanges({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
    });

    mockGetWorkspaceWithWorktree.mockResolvedValueOnce({
      workspace: { id: 'w1' },
      worktreePath: '/repo',
    });
    mockGitCommand.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'status failed',
    });
    await expect(caller.getUnstagedChanges({ workspaceId: 'w1' })).rejects.toThrow(
      'Git status failed: status failed'
    );
  });

  it('parses git status and unstaged changes', async () => {
    mockGetWorkspaceWithWorktree.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: '/repo',
    });
    mockGitCommand.mockResolvedValue({
      code: 0,
      stdout: ' M README.md\nM  package.json\n',
      stderr: '',
    });

    const caller = createCaller();
    await expect(caller.getGitStatus({ workspaceId: 'w1' })).resolves.toEqual({
      files: [
        { path: 'README.md', status: 'M', staged: false },
        { path: 'package.json', status: 'M', staged: true },
      ],
      hasUncommitted: true,
    });
    await expect(caller.getUnstagedChanges({ workspaceId: 'w1' })).resolves.toEqual({
      files: [{ path: 'README.md', status: 'M', staged: false }],
    });
  });

  it('handles diff-vs-main missing workspace/no-worktree and parses status lines', async () => {
    const caller = createCaller();
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValueOnce(null);
    await expect(caller.getDiffVsMain({ workspaceId: 'missing' })).rejects.toThrow(
      'Workspace not found: missing'
    );

    mockWorkspaceDataService.findByIdWithProject.mockResolvedValueOnce({
      id: 'w1',
      worktreePath: null,
      project: { defaultBranch: 'main' },
    });
    await expect(caller.getDiffVsMain({ workspaceId: 'w1' })).resolves.toEqual({
      added: [],
      modified: [],
      deleted: [],
      noMergeBase: false,
    });

    mockWorkspaceDataService.findByIdWithProject.mockResolvedValueOnce({
      id: 'w2',
      worktreePath: '/repo',
      project: {},
    });
    mockGetMergeBase.mockResolvedValueOnce('merge-base-sha');
    mockGitCommand.mockResolvedValueOnce({
      code: 0,
      stdout: 'A\tnew.ts\nM\tmod.ts\nD\tgone.ts\nR100\told.ts\tnew.ts\nbad-line\n',
      stderr: '',
    });
    await expect(caller.getDiffVsMain({ workspaceId: 'w2' })).resolves.toEqual({
      added: [{ path: 'new.ts', status: 'added' }],
      modified: [{ path: 'mod.ts', status: 'modified' }],
      deleted: [{ path: 'gone.ts', status: 'deleted' }],
      noMergeBase: false,
    });

    mockWorkspaceDataService.findByIdWithProject.mockResolvedValueOnce({
      id: 'w3',
      worktreePath: '/repo',
      project: { defaultBranch: 'main' },
    });
    mockGetMergeBase.mockResolvedValueOnce('merge-base-sha');
    mockGitCommand.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'diff failed',
    });
    await expect(caller.getDiffVsMain({ workspaceId: 'w3' })).rejects.toThrow(
      'Git diff failed: diff failed'
    );
  });

  it('handles unpushed-files branches for upstream and diff failures', async () => {
    const caller = createCaller();

    mockGetWorkspaceWithWorktree.mockResolvedValueOnce(null);
    await expect(caller.getUnpushedFiles({ workspaceId: 'missing' })).resolves.toEqual({
      files: [],
      hasUpstream: false,
    });

    mockGetWorkspaceWithWorktree.mockResolvedValueOnce({
      workspace: { id: 'w1' },
      worktreePath: '/repo',
    });
    mockGitCommand.mockResolvedValueOnce({
      code: 0,
      stdout: '\n',
      stderr: '',
    });
    await expect(caller.getUnpushedFiles({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
      hasUpstream: false,
    });

    mockGetWorkspaceWithWorktree.mockResolvedValueOnce({
      workspace: { id: 'w2' },
      worktreePath: '/repo',
    });
    mockGitCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'origin/main\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'cannot diff',
      });
    await expect(caller.getUnpushedFiles({ workspaceId: 'w2' })).rejects.toThrow(
      'Git diff failed: cannot diff'
    );

    mockGetWorkspaceWithWorktree.mockResolvedValueOnce({
      workspace: { id: 'w3' },
      worktreePath: '/repo',
    });
    mockGitCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'origin/main\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'src/a.ts\n\nsrc/b.ts\n',
        stderr: '',
      });
    await expect(caller.getUnpushedFiles({ workspaceId: 'w3' })).resolves.toEqual({
      files: ['src/a.ts', 'src/b.ts'],
      hasUpstream: true,
    });
  });

  it('handles diff-vs-main, unpushed files, and untracked file diff fallback', async () => {
    const caller = createCaller();

    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue({
      id: 'w1',
      worktreePath: '/repo',
      project: { defaultBranch: 'main' },
    });
    mockGetMergeBase.mockResolvedValueOnce(null);
    await expect(caller.getDiffVsMain({ workspaceId: 'w1' })).resolves.toEqual({
      added: [],
      modified: [],
      deleted: [],
      noMergeBase: true,
    });

    mockGetWorkspaceWithWorktree.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: '/repo',
    });
    mockGitCommand.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'no upstream',
    });
    await expect(caller.getUnpushedFiles({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
      hasUpstream: false,
    });

    const filePath = 'new-file.ts';
    writeFileSync(join(rootDir, filePath), 'export const x = 1;\n');
    mockGetWorkspaceWithProjectAndWorktreeOrThrow.mockResolvedValue({
      workspace: { id: 'w1', project: { defaultBranch: 'main' } },
      worktreePath: rootDir,
    });
    mockGetMergeBase.mockResolvedValueOnce('base-sha');
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    const diff = await caller.getFileDiff({ workspaceId: 'w1', filePath });
    expect(diff.diff).toContain('new file mode 100644');
    expect(diff.diff).toContain(`+++ b/${filePath}`);
  });

  it('handles getFileDiff validation, read failures, direct success, and git errors', async () => {
    const caller = createCaller();
    const filePath = 'src/main.ts';

    mockGetWorkspaceWithProjectAndWorktreeOrThrow.mockResolvedValueOnce({
      workspace: { id: 'w1', project: { defaultBranch: 'main' } },
      worktreePath: '/repo',
    });
    mockIsPathSafe.mockResolvedValueOnce(false);
    await expect(caller.getFileDiff({ workspaceId: 'w1', filePath })).rejects.toThrow(
      'Invalid file path'
    );

    mockGetWorkspaceWithProjectAndWorktreeOrThrow.mockResolvedValueOnce({
      workspace: { id: 'w2', project: { defaultBranch: 'main' } },
      worktreePath: '/repo',
    });
    mockIsPathSafe.mockResolvedValueOnce(true);
    mockGetMergeBase.mockResolvedValueOnce('base-sha');
    mockGitCommand
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    await expect(caller.getFileDiff({ workspaceId: 'w2', filePath })).resolves.toEqual({
      diff: '',
    });

    mockGetWorkspaceWithProjectAndWorktreeOrThrow.mockResolvedValueOnce({
      workspace: { id: 'w3', project: null },
      worktreePath: '/repo',
    });
    mockIsPathSafe.mockResolvedValueOnce(true);
    mockGetMergeBase.mockResolvedValueOnce(null);
    mockGitCommand.mockResolvedValueOnce({
      code: 0,
      stdout: 'diff --git a/src/main.ts b/src/main.ts\n',
      stderr: '',
    });
    await expect(caller.getFileDiff({ workspaceId: 'w3', filePath })).resolves.toEqual({
      diff: 'diff --git a/src/main.ts b/src/main.ts\n',
    });
    expect(mockGitCommand).toHaveBeenCalledWith(['diff', 'HEAD', '--', filePath], '/repo');

    mockGetWorkspaceWithProjectAndWorktreeOrThrow.mockResolvedValueOnce({
      workspace: { id: 'w4', project: { defaultBranch: 'main' } },
      worktreePath: '/repo',
    });
    mockIsPathSafe.mockResolvedValueOnce(true);
    mockGetMergeBase.mockResolvedValueOnce('base-sha');
    mockGitCommand.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'broken diff',
    });
    await expect(caller.getFileDiff({ workspaceId: 'w4', filePath })).rejects.toThrow(
      'Git diff failed: broken diff'
    );
  });
});
