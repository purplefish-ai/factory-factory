import { vi } from 'vitest';

const renameControl = vi.hoisted(() => ({
  fn: vi.fn(),
  write: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameControl.fn.mockImplementation(actual.rename);
  renameControl.write.mockImplementation(actual.writeFile);

  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => renameControl.write(...args),
    rename: (...args: Parameters<typeof actual.rename>) => renameControl.fn(...args),
  };
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-file';

describe('writeFileAtomic', () => {
  afterEach(() => {
    renameControl.fn.mockClear();
  });

  it('writes and replaces atomically', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
    const targetPath = path.join(baseDir, 'state.json');

    try {
      await fs.writeFile(targetPath, 'old', 'utf-8');
      await writeFileAtomic(targetPath, 'new', { encoding: 'utf-8' });

      const content = await fs.readFile(targetPath, 'utf-8');
      expect(content).toBe('new');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('creates parent directories as needed', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
    const targetPath = path.join(baseDir, 'nested', 'dir', 'config.json');

    try {
      await writeFileAtomic(targetPath, '{"ok":true}', { encoding: 'utf-8' });
      const content = await fs.readFile(targetPath, 'utf-8');
      expect(content).toBe('{"ok":true}');
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('cleans up temp file if rename fails', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
    const targetPath = path.join(baseDir, 'failing.json');

    renameControl.fn.mockRejectedValueOnce(new Error('rename failed for test'));

    try {
      await expect(writeFileAtomic(targetPath, 'x', { encoding: 'utf-8' })).rejects.toThrow(
        'rename failed for test'
      );

      const files = await fs.readdir(baseDir);
      const leftoverTmpFiles = files.filter((file) => file.includes('.tmp'));
      expect(leftoverTmpFiles).toHaveLength(0);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
  it('cleans partially written temporary bytes after a write failure', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
    renameControl.write.mockImplementationOnce(
      async (...args: Parameters<typeof actual.writeFile>) => {
        await actual.writeFile(...args);
        throw new Error('disk full');
      }
    );
    try {
      await expect(writeFileAtomic(path.join(dir, 'target.json'), 'partial')).rejects.toThrow(
        'disk full'
      );
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tags temporary files for owner-aware crash recovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
    try {
      await writeFileAtomic(path.join(dir, 'target.json'), 'bytes', {
        ...{ temporaryFileTag: 'archive-owner' },
      });
      expect(path.basename(renameControl.fn.mock.calls.at(-1)![0])).toMatch(
        /^\.tmp-archive-owner-/
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
