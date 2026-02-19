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
  return workspaceGitRouter.createCaller({
    appContext: {
      services: {
        createLogger: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
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
});
