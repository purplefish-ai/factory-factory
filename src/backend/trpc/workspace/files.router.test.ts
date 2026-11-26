import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetWorkspaceWithWorktree = vi.hoisted(() => vi.fn());
const mockGetWorkspaceWithWorktreeOrThrow = vi.hoisted(() => vi.fn());
const mockGitStateInvalidate = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.fn();

vi.mock('./workspace-helpers', () => ({
  getWorkspaceWithWorktree: (...args: unknown[]) => mockGetWorkspaceWithWorktree(...args),
  getWorkspaceWithWorktreeOrThrow: (...args: unknown[]) =>
    mockGetWorkspaceWithWorktreeOrThrow(...args),
}));

vi.mock('@/backend/services/workspace-git-state.service', () => ({
  workspaceGitStateService: { invalidate: mockGitStateInvalidate },
}));

import { workspaceFilesRouter } from './files.trpc';

function createCaller(signal?: AbortSignal) {
  return workspaceFilesRouter.createCaller(
    {
      appContext: {
        services: {
          createLogger: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: mockLoggerError,
          }),
          workspaceGitStateService: { invalidate: mockGitStateInvalidate },
        },
      },
    } as never,
    { signal }
  );
}

describe('workspaceFilesRouter', () => {
  let rootDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    rootDir = join(
      tmpdir(),
      `workspace-files-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('lists files recursively while excluding ignored and hidden paths', async () => {
    mkdirSync(join(rootDir, 'src'), { recursive: true });
    mkdirSync(join(rootDir, '.git'), { recursive: true });
    mkdirSync(join(rootDir, 'node_modules'), { recursive: true });
    writeFileSync(join(rootDir, 'README.md'), '# demo');
    writeFileSync(join(rootDir, 'src', 'index.ts'), 'export {}');
    writeFileSync(join(rootDir, '.secret'), 'nope');
    writeFileSync(join(rootDir, '.git', 'config'), 'git-config');
    writeFileSync(join(rootDir, 'node_modules', 'pkg.js'), 'ignored');

    mockGetWorkspaceWithWorktree.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: rootDir,
    });

    const caller = createCaller();
    const result = await caller.listAllFiles({ workspaceId: 'w1', limit: 50 });

    expect(result.hasWorktree).toBe(true);
    expect(result.files).toEqual(
      expect.arrayContaining(['README.md', path.join('src', 'index.ts')])
    );
    expect(result.files).not.toEqual(
      expect.arrayContaining(['.secret', '.git/config', 'node_modules/pkg.js'])
    );
  });

  it('lists directory entries and reads file content', async () => {
    mkdirSync(join(rootDir, 'dirA'), { recursive: true });
    mkdirSync(join(rootDir, '.git'), { recursive: true });
    writeFileSync(join(rootDir, 'fileB.txt'), 'hello world');

    mockGetWorkspaceWithWorktree.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: rootDir,
    });
    mockGetWorkspaceWithWorktreeOrThrow.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: rootDir,
    });

    const caller = createCaller();
    const list = await caller.listFiles({ workspaceId: 'w1' });
    expect(list.hasWorktree).toBe(true);
    expect(list.entries.map((e) => e.name)).toEqual(['dirA', 'fileB.txt']);

    const file = await caller.readFile({ workspaceId: 'w1', path: 'fileB.txt' });
    expect(file.content).toBe('hello world');
    expect(file.isBinary).toBe(false);
    expect(file.truncated).toBe(false);
  });

  it('passes fuzzy filename matching through to the workspace search', async () => {
    mkdirSync(join(rootDir, 'src'));
    writeFileSync(join(rootDir, 'src', 'Button.tsx'), 'export {}');
    mockGetWorkspaceWithWorktree.mockResolvedValue({ worktreePath: rootDir });

    const result = await createCaller().listAllFiles({
      workspaceId: 'w1',
      query: 'bttn',
      match: 'fuzzy',
    });
    expect(result).toEqual({ files: [join('src', 'Button.tsx')], hasWorktree: true });
  });

  it('reports a cancelled search to the caller without logging it as an error', async () => {
    mockGetWorkspaceWithWorktree.mockResolvedValue({ worktreePath: rootDir });
    const reason = new Error('Cancelled search');
    const caller = createCaller(AbortSignal.abort(reason));

    await expect(
      caller.listAllFiles({ workspaceId: 'w1', query: 'bttn', match: 'fuzzy' })
    ).rejects.toMatchObject({ cause: reason });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('lists, reads, and deletes screenshots with path validation', async () => {
    const screenshotsDir = join(rootDir, '.factory-factory', 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });
    const screenshotPath = join(screenshotsDir, 'shot.png');
    writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(screenshotsDir, 'note.txt'), 'ignore me');

    mockGetWorkspaceWithWorktree.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: rootDir,
    });
    mockGetWorkspaceWithWorktreeOrThrow.mockResolvedValue({
      workspace: { id: 'w1' },
      worktreePath: rootDir,
    });

    const caller = createCaller();

    const listed = await caller.listScreenshots({ workspaceId: 'w1' });
    expect(listed).toEqual({
      screenshots: [
        {
          name: 'shot.png',
          path: '.factory-factory/screenshots/shot.png',
          size: 4,
        },
      ],
      hasWorktree: true,
    });

    const read = await caller.readScreenshot({
      workspaceId: 'w1',
      path: '.factory-factory/screenshots/shot.png',
    });
    expect(read.mimeType).toBe('image/png');
    expect(read.name).toBe('shot.png');
    expect(Buffer.from(read.data, 'base64')).toEqual(readFileSync(screenshotPath));

    await expect(
      caller.readScreenshot({ workspaceId: 'w1', path: '../outside.png' })
    ).rejects.toThrow('Invalid screenshot path');

    await expect(
      caller.deleteScreenshot({
        workspaceId: 'w1',
        path: '.factory-factory/screenshots/shot.png',
      })
    ).resolves.toEqual({ success: true });
    expect(() => unlinkSync(screenshotPath)).toThrow();
    expect(mockGitStateInvalidate).toHaveBeenCalledWith(rootDir);
  });
});
