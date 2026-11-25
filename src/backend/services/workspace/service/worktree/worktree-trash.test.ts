import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { execCommand } from '@/backend/lib/shell';
import { JobRunner } from '@/backend/services/job-runner.service';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualShell =
  await vi.importActual<typeof import('@/backend/lib/shell')>('@/backend/lib/shell');

const mockRename = vi.hoisted(() => vi.fn());
const mockExecCommand = vi.hoisted(() => vi.fn());

vi.mock('@/backend/lib/shell', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/backend/lib/shell')>();
  return { ...original, execCommand: (...args: unknown[]) => mockExecCommand(...args) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: (...args: Parameters<typeof original.rename>) => mockRename(...args),
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/backend/services/workspace/resources/project.accessor', () => ({
  projectAccessor: { listWorktreeBasePaths: vi.fn(async () => []) },
}));

import {
  deleteTrashEntry,
  detachWorktreeDirectory,
  findTrashDir,
  isTrashEntryName,
  removeTreeUntilAborted,
  trashEntryName,
  WORKTREE_TRASH_DIR_NAME,
} from './worktree-trash';
import { WorktreeTrashReclaimer } from './worktree-trash-reclaimer.service';

let root: string;
let base: string;

async function makeTree(dir: string, files = 3): Promise<void> {
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  for (let index = 0; index < files; index++) {
    await writeFile(path.join(dir, 'node_modules', 'pkg', `f${index}.js`), 'x');
  }
  await writeFile(path.join(dir, 'README.md'), 'hello');
}

beforeEach(async () => {
  mockRename.mockImplementation((from: string, to: string) => actualFs.rename(from, to));
  mockExecCommand.mockImplementation((...args: Parameters<typeof execCommand>) =>
    actualShell.execCommand(...args)
  );
  root = await actualFs.realpath(await mkdtemp(path.join(tmpdir(), 'ff-worktree-trash-')));
  base = path.join(root, 'worktrees');
  await mkdir(base);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('trash entry names', () => {
  it('accepts only names it generates', () => {
    const name = trashEntryName('workspace-abc123');
    expect(name.startsWith('workspace-abc123.')).toBe(true);
    expect(isTrashEntryName(name)).toBe(true);
    expect(isTrashEntryName(trashEntryName('odd name/with:chars'))).toBe(true);
    for (const foreign of ['workspace-abc123', 'notes.txt', '.DS_Store', '..', 'a.b-c']) {
      expect(isTrashEntryName(foreign)).toBe(false);
    }
  });
});

describe('detachWorktreeDirectory', () => {
  it('renames the worktree into the trash of its canonical base', async () => {
    const worktree = path.join(base, 'workspace-one');
    await makeTree(worktree);

    const result = await detachWorktreeDirectory(worktree, base);

    expect(result.kind).toBe('moved');
    await expect(actualFs.lstat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    const entries = await readdir(path.join(base, WORKTREE_TRASH_DIR_NAME));
    expect(entries).toHaveLength(1);
    expect(isTrashEntryName(entries[0]!)).toBe(true);
    const trashed = path.join(base, WORKTREE_TRASH_DIR_NAME, entries[0]!);
    expect(await readFile(path.join(trashed, 'README.md'), 'utf8')).toBe('hello');
  });

  it('deletes in place when the rename crosses devices', async () => {
    const worktree = path.join(base, 'workspace-mounted');
    await makeTree(worktree);
    mockRename.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));

    const result = await detachWorktreeDirectory(worktree, base);

    expect(result).toEqual({
      kind: 'deleted',
      moveError: expect.objectContaining({ code: 'EXDEV' }),
    });
    await expect(actualFs.lstat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(base, WORKTREE_TRASH_DIR_NAME))).toEqual([]);
  });

  it('deletes in place rather than move through a trash that is a symlink', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(base, WORKTREE_TRASH_DIR_NAME), 'dir');
    const worktree = path.join(base, 'workspace-two');
    await makeTree(worktree);

    const result = await detachWorktreeDirectory(worktree, base);

    expect(result.kind).toBe('deleted');
    await expect(actualFs.lstat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe('findTrashDir', () => {
  it('resolves the trash through a symlinked base and refuses a symlinked trash', async () => {
    const linkedBase = path.join(root, 'linked');
    await symlink(base, linkedBase, 'dir');
    await expect(findTrashDir(linkedBase)).resolves.toBeNull();
    await mkdir(path.join(base, WORKTREE_TRASH_DIR_NAME));
    await expect(findTrashDir(linkedBase)).resolves.toBe(path.join(base, WORKTREE_TRASH_DIR_NAME));
    await expect(findTrashDir(path.join(root, 'missing'))).resolves.toBeNull();

    const otherBase = path.join(root, 'other');
    await mkdir(otherBase);
    await symlink(base, path.join(otherBase, WORKTREE_TRASH_DIR_NAME), 'dir');
    await expect(findTrashDir(otherBase)).rejects.toThrow('not a directory');
  });
});

describe('WorktreeTrashReclaimer', () => {
  function reclaimerFor(bases: string[]) {
    return new WorktreeTrashReclaimer(
      { listWorktreeBasePaths: async () => bases },
      new JobRunner()
    );
  }

  it('deletes only entries it created, without following symlinks', async () => {
    const trash = path.join(base, WORKTREE_TRASH_DIR_NAME);
    await mkdir(trash);
    const ours = path.join(trash, trashEntryName('workspace-a'));
    await makeTree(ours, 20);
    const foreign = path.join(trash, 'keep-me');
    await mkdir(foreign);
    await writeFile(path.join(foreign, 'file'), 'precious');
    const target = path.join(root, 'link-target');
    await mkdir(target);
    await writeFile(path.join(target, 'file'), 'precious');
    const ourLink = path.join(trash, trashEntryName('workspace-link'));
    await symlink(target, ourLink, 'dir');
    await symlink(target, path.join(ours, 'node_modules', 'link'), 'dir');

    await reclaimerFor([base, base]).run(new AbortController().signal);

    expect((await readdir(trash)).sort()).toEqual(['keep-me']);
    expect(await readFile(path.join(foreign, 'file'), 'utf8')).toBe('precious');
    expect(await readFile(path.join(target, 'file'), 'utf8')).toBe('precious');
  });

  it('resumes a partly deleted entry on its next run', async () => {
    const trash = path.join(base, WORKTREE_TRASH_DIR_NAME);
    await mkdir(trash);
    const entry = path.join(trash, trashEntryName('workspace-partial'));
    await makeTree(entry, 10);
    // What an interrupted `rm -rf` leaves: some files gone, the entry kept.
    await rm(path.join(entry, 'README.md'));
    await rm(path.join(entry, 'node_modules', 'pkg', 'f0.js'));

    await reclaimerFor([base]).run(new AbortController().signal);

    expect(await readdir(trash)).toEqual([]);
  });

  it('stops on abort, leaving entries for the next run', async () => {
    const trash = path.join(base, WORKTREE_TRASH_DIR_NAME);
    await mkdir(trash);
    const first = path.join(trash, trashEntryName('workspace-first'));
    const second = path.join(trash, trashEntryName('workspace-second'));
    await makeTree(first);
    await makeTree(second);
    const controller = new AbortController();
    controller.abort();

    await reclaimerFor([base]).run(controller.signal);
    expect((await readdir(trash)).sort()).toEqual(
      [path.basename(first), path.basename(second)].sort()
    );

    await reclaimerFor([base]).run(new AbortController().signal);
    expect(await readdir(trash)).toEqual([]);
  });

  it('skips a base whose trash fails its safety checks', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    const stray = path.join(elsewhere, trashEntryName('workspace-x'));
    await makeTree(stray);
    await symlink(elsewhere, path.join(base, WORKTREE_TRASH_DIR_NAME), 'dir');

    await reclaimerFor([base]).run(new AbortController().signal);

    expect(await readdir(elsewhere)).toEqual([path.basename(stray)]);
  });

  it('runs at start and again when woken', async () => {
    const runner = new JobRunner();
    const listWorktreeBasePaths = vi.fn(async () => [base]);
    const reclaimer = new WorktreeTrashReclaimer({ listWorktreeBasePaths }, runner);
    reclaimer.wake();
    expect(listWorktreeBasePaths).not.toHaveBeenCalled();

    reclaimer.start();
    await vi.waitFor(() => expect(listWorktreeBasePaths).toHaveBeenCalledTimes(1));
    await runner.waitForCurrentRun('worktree-trash-reclaim');
    reclaimer.wake();
    await vi.waitFor(() => expect(listWorktreeBasePaths).toHaveBeenCalledTimes(2));
    await reclaimer.stop();
  });
});

describe('deleteTrashEntry', () => {
  it.skipIf(process.platform === 'win32')(
    'ends without error when aborted mid-way, and a later call finishes it',
    async () => {
      const entry = path.join(base, trashEntryName('workspace-big'));
      await makeTree(entry, 3000);
      const controller = new AbortController();
      // Abort only once `rm` has been spawned, so the kill lands mid-deletion.
      mockExecCommand.mockImplementationOnce((...args: Parameters<typeof execCommand>) => {
        const running = actualShell.execCommand(...args);
        controller.abort();
        return running;
      });

      await expect(deleteTrashEntry(entry, controller.signal)).resolves.toBeUndefined();
      expect(mockExecCommand).toHaveBeenCalledWith(
        'rm',
        ['-rf', '--', entry],
        expect.objectContaining({ timeout: 0, signal: controller.signal })
      );
      await deleteTrashEntry(entry, new AbortController().signal).catch((error: unknown) => {
        // The killed deletion may already have finished the entry.
        expect(error).toMatchObject({ code: 'ENOENT' });
      });
      await expect(actualFs.lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});

describe('removeTreeUntilAborted', () => {
  it('removes a tree without following links, and stops between removals on abort', async () => {
    const target = path.join(root, 'link-target');
    await mkdir(target);
    await writeFile(path.join(target, 'file'), 'precious');
    const tree = path.join(base, 'tree');
    await makeTree(tree, 5);
    await symlink(target, path.join(tree, 'node_modules', 'link'), 'dir');

    const aborted = new AbortController();
    aborted.abort();
    await removeTreeUntilAborted(tree, aborted.signal);
    expect(await readFile(path.join(tree, 'README.md'), 'utf8')).toBe('hello');

    await removeTreeUntilAborted(tree, new AbortController().signal);
    await expect(actualFs.lstat(tree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(target, 'file'), 'utf8')).toBe('precious');
  });

  it('refuses to enter a directory that is a link when it is opened', async () => {
    const target = path.join(root, 'outside');
    await mkdir(target);
    await writeFile(path.join(target, 'file'), 'precious');
    const swapped = path.join(base, 'swapped');
    await symlink(target, swapped, 'dir');

    await expect(removeTreeUntilAborted(swapped, new AbortController().signal)).rejects.toThrow(
      'Refusing to descend into a link'
    );
    expect(await readFile(path.join(target, 'file'), 'utf8')).toBe('precious');
  });
});
