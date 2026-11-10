import { fstatSync, renameSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneRotatedLogFiles, RotatingLogFile } from './rotating-log-file';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ff-rotating-log-'));
  path = join(dir, 'server.log');
});

afterEach(async () => {
  vi.mocked(renameSync).mockClear();
  await rm(dir, { recursive: true, force: true });
});

function line(index: number): string {
  // Ten bytes per line, so sizes are easy to reason about.
  return `line-${String(index).padStart(4, '0')}\n`;
}

async function settledContent(file: string, expected: string): Promise<void> {
  await vi.waitFor(async () => expect(await readFile(file, 'utf8')).toBe(expected));
}

describe('RotatingLogFile', () => {
  it('rotates at the size limit and keeps only the configured number of old files', async () => {
    const log = new RotatingLogFile({ path, maxBytes: 30, maxRotatedFiles: 2 });

    for (let index = 0; index < 13; index++) {
      log.write(line(index));
    }

    // 13 lines of 10 bytes: four full 30-byte files, the oldest dropped.
    await settledContent(path, line(12));
    await settledContent(`${path}.1`, line(9) + line(10) + line(11));
    await settledContent(`${path}.2`, line(6) + line(7) + line(8));
    expect((await readdir(dir)).sort()).toEqual(['server.log', 'server.log.1', 'server.log.2']);
  });

  it('tracks size in-process instead of stating the file for every write', () => {
    const log = new RotatingLogFile({ path, maxBytes: 1024 * 1024, maxRotatedFiles: 3 });
    vi.mocked(fstatSync).mockClear();

    for (let index = 0; index < 200; index++) {
      log.write(line(index));
    }

    expect(fstatSync).toHaveBeenCalledOnce();
  });

  it('continues an existing file below the limit and counts its bytes', async () => {
    await writeFile(path, line(0) + line(1));
    const log = new RotatingLogFile({ path, maxBytes: 30, maxRotatedFiles: 2 });

    log.write(line(2));
    log.write(line(3));

    await settledContent(`${path}.1`, line(0) + line(1) + line(2));
    await settledContent(path, line(3));
  });

  it('moves a file already over the limit aside before the first write', async () => {
    const oversized = 'x'.repeat(500);
    await writeFile(path, oversized);
    await writeFile(`${path}.1`, 'older');
    const log = new RotatingLogFile({ path, maxBytes: 100, maxRotatedFiles: 2 });

    log.write(line(0));

    await settledContent(path, line(0));
    expect(await readFile(`${path}.1`, 'utf8')).toBe(oversized);
    expect(await readFile(`${path}.2`, 'utf8')).toBe('older');
  });

  it('keeps appending when rotation fails and retries only after another full file', async () => {
    const log = new RotatingLogFile({ path, maxBytes: 20, maxRotatedFiles: 2 });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });

    for (let index = 0; index < 5; index++) {
      log.write(line(index));
    }

    // The failed attempt after line 1 keeps lines 2 and 3 in the same file;
    // lines 2 and 3 do not retry, and the retry after line 3 succeeds.
    expect(vi.mocked(renameSync).mock.calls).toEqual([
      [`${path}.1`, `${path}.2`],
      [`${path}.1`, `${path}.2`],
      [path, `${path}.1`],
    ]);
    await settledContent(`${path}.1`, line(0) + line(1) + line(2) + line(3));
    await settledContent(path, line(4));
  });
});

describe('pruneRotatedLogFiles', () => {
  it('deletes only rotated files older than the cutoff', async () => {
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
    await writeFile(path, 'current');
    await utimes(path, old, old);
    await writeFile(`${path}.1`, 'recent');
    await writeFile(`${path}.2`, 'stale');
    await utimes(`${path}.2`, old, old);
    await writeFile(join(dir, 'other.log'), 'unrelated');
    await utimes(join(dir, 'other.log'), old, old);

    const deleted = await pruneRotatedLogFiles(path, 3, now - 7 * 24 * 60 * 60 * 1000);

    expect(deleted).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['other.log', 'server.log', 'server.log.1']);
  });
});
