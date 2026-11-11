import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHistoryFile } from './session-history-file';

const directories: string[] = [];
function historyFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ff-history-file-'));
  directories.push(directory);
  const filePath = join(directory, 'history.jsonl');
  writeFileSync(filePath, '{"line":1}\n');
  return filePath;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadHistoryFile', () => {
  it('reads without stat identity when the caller offers no reuse', async () => {
    const filePath = historyFile();
    await expect(
      loadHistoryFile({
        filePath,
        reuse: undefined,
        read: async () => ({ history: [], hadReadError: false }),
      })
    ).resolves.toEqual({ status: 'loaded', history: [], filePath });
  });

  it('skips the read when the caller reuses the offered identity', async () => {
    const filePath = historyFile();
    const read = vi.fn();
    const reuse = vi.fn(() => 'cached');
    await expect(loadHistoryFile({ filePath, reuse, read })).resolves.toEqual({
      status: 'reused',
      value: 'cached',
      filePath,
    });
    expect(read).not.toHaveBeenCalled();
    const stats = statSync(filePath);
    expect(reuse).toHaveBeenCalledWith({
      filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: stats.ino,
    });
  });

  it('reports the identity only when the file was unchanged across the read', async () => {
    const filePath = historyFile();
    const unchanged = await loadHistoryFile({
      filePath,
      reuse: () => undefined,
      read: async () => ({ history: [], hadReadError: false }),
    });
    expect(unchanged).toMatchObject({ status: 'loaded', file: { filePath, size: 11 } });

    const appended = await loadHistoryFile({
      filePath,
      reuse: () => undefined,
      read: () => {
        appendFileSync(filePath, '{"line":2}\n');
        return Promise.resolve({ history: [], hadReadError: false });
      },
    });
    expect(appended).toEqual({ status: 'loaded', history: [], filePath });
  });

  it('keeps read failures as errors', async () => {
    const filePath = historyFile();
    await expect(
      loadHistoryFile({
        filePath,
        reuse: () => undefined,
        read: async () => ({ history: [], hadReadError: true }),
      })
    ).resolves.toEqual({ status: 'error', reason: 'read_failed', filePath });
  });
});
