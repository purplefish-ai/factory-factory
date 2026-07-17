import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWorkspaceDataService = vi.hoisted(() => ({
  findByIdWithProject: vi.fn(),
}));
const mockGetWorkspaceWithProjectAndWorktreeOrThrow = vi.hoisted(() => vi.fn());
const mockGitCommand = vi.hoisted(() => vi.fn());
const mockIsPathSafe = vi.hoisted(() => vi.fn(async () => true));
const mockGetSnapshot = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: mockWorkspaceDataService,
}));

vi.mock('./workspace-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-helpers')>();
  return {
    ...actual,
    getWorkspaceWithProjectAndWorktreeOrThrow: (...args: unknown[]) =>
      mockGetWorkspaceWithProjectAndWorktreeOrThrow(...args),
  };
});

vi.mock('@/backend/services/workspace-git-state.service', () => ({
  workspaceGitStateService: {
    getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
  },
}));

vi.mock('@/backend/lib/shell', () => ({
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

vi.mock('@/backend/lib/file-helpers', () => ({
  isPathSafe: mockIsPathSafe,
}));

import { workspaceGitRouter } from './git.trpc';

function makeSnapshot(
  overrides: {
    status?: Record<string, unknown>;
    base?: Record<string, unknown>;
    upstream?: Record<string, unknown>;
  } = {}
) {
  return {
    worktreePath: '/repo/w1',
    defaultBranch: 'main',
    computedAt: 1,
    status: {
      files: [
        { path: 'README.md', status: 'M', staged: false },
        { path: 'package.json', status: 'M', staged: true },
      ],
      hasUncommitted: true,
      ...overrides.status,
    },
    base: {
      mergeBase: 'merge-base-sha',
      noMergeBase: false,
      stats: { total: 3, additions: 2, deletions: 1, hasUncommitted: true },
      added: [{ path: 'new.ts', status: 'added' }],
      modified: [{ path: 'mod.ts', status: 'modified' }],
      deleted: [{ path: 'gone.ts', status: 'deleted' }],
      ...overrides.base,
    },
    upstream: {
      ref: 'origin/feature',
      hasUpstream: true,
      files: ['src/a.ts', 'src/b.ts'],
      ...overrides.upstream,
    },
  };
}

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

  it('preserves NOT_FOUND errors for every aggregate endpoint when the workspace is missing', async () => {
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue(null);
    const caller = createCaller();

    const requests = [
      caller.getGitStatus({ workspaceId: 'missing' }),
      caller.getUnstagedChanges({ workspaceId: 'missing' }),
      caller.getDiffVsMain({ workspaceId: 'missing' }),
      caller.getUnpushedFiles({ workspaceId: 'missing' }),
    ];

    await Promise.all(
      requests.map((request) =>
        expect(request).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'Workspace not found: missing',
        })
      )
    );
  });

  it('preserves empty aggregate responses when workspace has no worktree', async () => {
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue({
      id: 'w1',
      worktreePath: null,
      project: { defaultBranch: 'main' },
    });
    const caller = createCaller();
    await expect(caller.getGitStatus({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
      hasUncommitted: false,
    });
    await expect(caller.getUnstagedChanges({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
    });
    await expect(caller.getDiffVsMain({ workspaceId: 'w1' })).resolves.toEqual({
      added: [],
      modified: [],
      deleted: [],
      noMergeBase: false,
    });
    await expect(caller.getUnpushedFiles({ workspaceId: 'w1' })).resolves.toEqual({
      files: [],
      hasUpstream: false,
    });
    expect(mockGetSnapshot).not.toHaveBeenCalled();
  });

  it('projects all aggregate endpoints from concurrent shared snapshot requests', async () => {
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue({
      id: 'w1',
      worktreePath: '/repo/w1',
      project: { defaultBranch: 'main' },
    });
    const snapshot = makeSnapshot();
    const sharedRequest = Promise.resolve(snapshot);
    mockGetSnapshot.mockReturnValue(sharedRequest);

    const caller = createCaller();
    const [status, unstaged, diff, unpushed] = await Promise.all([
      caller.getGitStatus({ workspaceId: 'w1' }),
      caller.getUnstagedChanges({ workspaceId: 'w1' }),
      caller.getDiffVsMain({ workspaceId: 'w1' }),
      caller.getUnpushedFiles({ workspaceId: 'w1' }),
    ]);

    expect(status).toEqual({
      files: [
        { path: 'README.md', status: 'M', staged: false },
        { path: 'package.json', status: 'M', staged: true },
      ],
      hasUncommitted: true,
    });
    expect(unstaged).toEqual({
      files: [{ path: 'README.md', status: 'M', staged: false }],
    });
    expect(diff).toEqual({
      added: [{ path: 'new.ts', status: 'added' }],
      modified: [{ path: 'mod.ts', status: 'modified' }],
      deleted: [{ path: 'gone.ts', status: 'deleted' }],
      noMergeBase: false,
    });
    expect(unpushed).toEqual({
      files: ['src/a.ts', 'src/b.ts'],
      hasUpstream: true,
    });
    expect(mockGetSnapshot).toHaveBeenCalledTimes(4);
    expect(mockGetSnapshot).toHaveBeenCalledWith({
      worktreePath: '/repo/w1',
      defaultBranch: 'main',
    });
    expect(mockGitCommand).not.toHaveBeenCalled();
  });

  it('throws only errors from the section requested by each endpoint', async () => {
    const caller = createCaller();
    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue({
      id: 'w1',
      worktreePath: '/repo/w1',
      project: { defaultBranch: 'main' },
    });

    mockGetSnapshot.mockResolvedValue(
      makeSnapshot({ base: { error: 'base failed' }, upstream: { error: 'upstream failed' } })
    );
    await expect(caller.getGitStatus({ workspaceId: 'w1' })).resolves.toMatchObject({
      hasUncommitted: true,
    });
    await expect(caller.getUnstagedChanges({ workspaceId: 'w1' })).resolves.toEqual({
      files: [{ path: 'README.md', status: 'M', staged: false }],
    });

    mockGetSnapshot.mockResolvedValue(
      makeSnapshot({ status: { error: 'status failed' }, upstream: { error: 'upstream failed' } })
    );
    await expect(caller.getDiffVsMain({ workspaceId: 'w1' })).resolves.toMatchObject({
      noMergeBase: false,
    });

    mockGetSnapshot.mockResolvedValue(
      makeSnapshot({ status: { error: 'status failed' }, base: { error: 'base failed' } })
    );
    await expect(caller.getUnpushedFiles({ workspaceId: 'w1' })).resolves.toMatchObject({
      hasUpstream: true,
    });

    mockGetSnapshot.mockResolvedValue(makeSnapshot({ status: { error: 'status failed' } }));
    await expect(caller.getGitStatus({ workspaceId: 'w1' })).rejects.toThrow(
      'Git status failed: status failed'
    );
    await expect(caller.getUnstagedChanges({ workspaceId: 'w1' })).rejects.toThrow(
      'Git status failed: status failed'
    );

    mockGetSnapshot.mockResolvedValue(makeSnapshot({ base: { error: 'base failed' } }));
    await expect(caller.getDiffVsMain({ workspaceId: 'w1' })).rejects.toThrow(
      'Git diff failed: base failed'
    );

    mockGetSnapshot.mockResolvedValue(makeSnapshot({ upstream: { error: 'upstream failed' } }));
    await expect(caller.getUnpushedFiles({ workspaceId: 'w1' })).rejects.toThrow(
      'Git diff failed: upstream failed'
    );
  });

  it('handles no merge base, no upstream, and untracked file diff fallback', async () => {
    const caller = createCaller();

    mockWorkspaceDataService.findByIdWithProject.mockResolvedValue({
      id: 'w1',
      worktreePath: '/repo',
      project: { defaultBranch: 'main' },
    });
    mockGetSnapshot.mockResolvedValueOnce(
      makeSnapshot({
        base: { mergeBase: null, noMergeBase: true, added: [], modified: [], deleted: [] },
      })
    );
    await expect(caller.getDiffVsMain({ workspaceId: 'w1' })).resolves.toEqual({
      added: [],
      modified: [],
      deleted: [],
      noMergeBase: true,
    });

    mockGetSnapshot.mockResolvedValueOnce(
      makeSnapshot({ upstream: { ref: null, hasUpstream: false, files: [] } })
    );
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
    mockGetSnapshot.mockResolvedValueOnce(makeSnapshot({ base: { mergeBase: 'base-sha' } }));
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
    mockGetSnapshot.mockResolvedValueOnce(makeSnapshot({ base: { mergeBase: 'base-sha' } }));
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
    mockGetSnapshot.mockResolvedValueOnce(makeSnapshot({ base: { mergeBase: null } }));
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
    mockGetSnapshot.mockResolvedValueOnce(makeSnapshot({ base: { mergeBase: 'base-sha' } }));
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
