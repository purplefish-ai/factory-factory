import { vi } from 'vitest';

const fsControl = vi.hoisted(() => ({
  rename: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsControl.rename.mockImplementation(actual.rename);
  fsControl.writeFile.mockImplementation(actual.writeFile);
  fsControl.unlink.mockImplementation(actual.unlink);

  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => fsControl.rename(...args),
    writeFile: (...args: Parameters<typeof actual.writeFile>) => fsControl.writeFile(...args),
    unlink: (...args: Parameters<typeof actual.unlink>) => fsControl.unlink(...args),
  };
});

import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-file';

describe('writeFileAtomic', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes and replaces atomically', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
    const targetPath = path.join(baseDir, 'state.json');

    try {
      await fs.writeFile(targetPath, 'old', 'utf-8');
      await writeFileAtomic(targetPath, 'new', { encoding: 'utf-8' });

      const content = await fs.readFile(targetPath, 'utf-8');
      expect(content).toBe('new');
      expect(await fs.readdir(baseDir)).toEqual(['state.json']);
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

    await fs.writeFile(targetPath, 'old', 'utf-8');
    await fs.writeFile(path.join(baseDir, '.tmp-other-writer'), 'other', 'utf-8');
    const error = new Error('rename failed for test');
    fsControl.rename.mockRejectedValueOnce(error);

    try {
      await expect(writeFileAtomic(targetPath, 'x', { encoding: 'utf-8' })).rejects.toBe(error);

      expect(await fs.readFile(targetPath, 'utf-8')).toBe('old');
      expect(await fs.readFile(path.join(baseDir, '.tmp-other-writer'), 'utf-8')).toBe('other');
      expect((await fs.readdir(baseDir)).sort()).toEqual(['.tmp-other-writer', 'failing.json']);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it.each(['string', 'buffer'] as const)(
    'cleans up a partial %s write while preserving the destination and other temporary files',
    async (contentType) => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
      const targetPath = path.join(baseDir, 'state.json');
      const otherTempPath = path.join(baseDir, '.tmp-other-writer');
      const error = new Error('write failed after partial content');

      try {
        await fs.writeFile(targetPath, 'old', 'utf-8');
        await fs.writeFile(otherTempPath, 'other', 'utf-8');
        fsControl.writeFile.mockImplementationOnce((tmpPath: string) => {
          writeFileSync(tmpPath, 'partial');
          return Promise.reject(error);
        });

        const content = contentType === 'string' ? 'new' : Buffer.from('new');
        await expect(writeFileAtomic(targetPath, content)).rejects.toBe(error);

        expect(await fs.readFile(targetPath, 'utf-8')).toBe('old');
        expect(await fs.readFile(otherTempPath, 'utf-8')).toBe('other');
        expect((await fs.readdir(baseDir)).sort()).toEqual(['.tmp-other-writer', 'state.json']);
      } finally {
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    }
  );

  it.each(['writeFile', 'rename'] as const)(
    'preserves the %s error when temporary-file cleanup also fails',
    async (operation) => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-atomic-file-'));
      const targetPath = path.join(baseDir, 'state.json');
      const error = new Error(`${operation} failed`);

      try {
        await fs.writeFile(targetPath, 'old', 'utf-8');
        fsControl[operation].mockRejectedValueOnce(error);
        fsControl.unlink.mockRejectedValueOnce(new Error('cleanup failed'));

        await expect(writeFileAtomic(targetPath, 'new')).rejects.toBe(error);
        expect(await fs.readFile(targetPath, 'utf-8')).toBe('old');
      } finally {
        // Reset any unused one-shot cleanup failure before removing the fixture.
        fsControl.unlink.mockReset();
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        fsControl.unlink.mockImplementation(actual.unlink);
        await fs.rm(baseDir, { recursive: true, force: true });
      }
    }
  );
});
