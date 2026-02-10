import { vi } from 'vitest';

const renameControl = vi.hoisted(() => ({
  fn: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  renameControl.fn.mockImplementation(actual.rename);

  return {
    ...actual,
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
});
