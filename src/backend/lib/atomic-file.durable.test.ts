import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFileAtomic } from './atomic-file';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
});

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  'syncs bytes before rename, directory ancestry afterward (parents precreated=%s)',
  async (precreated) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ff-durable-'));
    const directory = join(root, 'archives', 'workspace');
    const events: string[] = [];
    if (precreated) {
      await fs.mkdir(directory, { recursive: true });
    }
    const { open, rename } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push(String(args[0]));
        await sync();
      });
      return handle;
    });
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      events.push('rename');
      await rename(...args);
    });
    try {
      await writeFileAtomic(join(directory, 'transcript.json'), 'retained bytes', {
        durable: true,
        durableDirectoryRoot: root,
      });
      expect(events).toHaveLength(5);
      expect(basename(events[0]!)).toMatch(/^\.tmp-/);
      expect(dirname(events[0]!)).toBe(directory);
      expect(events.slice(1)).toEqual(['rename', directory, dirname(directory), root]);
      expect(await fs.readFile(join(directory, 'transcript.json'), 'utf8')).toBe('retained bytes');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

it.each(['file', 'directory'])(
  'rejects a %s sync failure instead of promising durability',
  async (phase) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ff-durable-failure-'));
    const target = join(root, 'transcript.json');
    const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const rename = vi.mocked(fs.rename);
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      const isDirectory = String(args[0]) === root;
      if (isDirectory === (phase === 'directory')) {
        vi.spyOn(handle, 'sync').mockRejectedValue(new Error('sync failed'));
      }
      return handle;
    });
    try {
      await expect(writeFileAtomic(target, 'proof', { ...{ durable: true } })).rejects.toThrow(
        'sync failed'
      );
      expect(rename).toHaveBeenCalledTimes(phase === 'file' ? 0 : 1);
      expect((await fs.readdir(root)).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
