import { appendFileSync, mkdirSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLogger } from './logger.service';

const fallback = vi.hoisted(() => ({
  write: vi.fn<(fd: number, bytes: Uint8Array, offset: number, length: number) => number>(),
}));

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  writeSync: fallback.write,
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
  createWriteStream: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  fallback.write.mockImplementation((_fd, _bytes, _offset, length) => length);
  // Test processes only get a log file under the OS temp directory. node:fs
  // is mocked, so nothing is created there.
  vi.stubEnv('BASE_DIR', join(tmpdir(), 'ff-fatal-fallback-test'));
});

afterEach(() => vi.unstubAllEnvs());

describe('fatal log fallback', () => {
  it('keeps healthy fatal writes off stderr', () => {
    createLogger('fatal-fallback').fatal('terminal failure', new Error('original cause'));

    expect(appendFileSync).toHaveBeenCalledOnce();
    expect(writeSync).not.toHaveBeenCalled();
  });

  it.each(['append', 'directory'] as const)(
    'writes one synchronous stderr record when %s fails',
    (failure) => {
      vi.mocked(failure === 'append' ? appendFileSync : mkdirSync).mockImplementation(() => {
        throw new Error('filesystem unavailable');
      });
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      createLogger('fatal-fallback').fatal('terminal failure', new Error('original cause'));

      expect(writeSync).toHaveBeenCalledExactlyOnceWith(
        2,
        expect.any(Buffer),
        0,
        expect.any(Number)
      );
      const [, bytes] = fallback.write.mock.calls[0]!;
      const record = Buffer.from(bytes).toString('utf8');
      expect(record).toMatch(/\n$/);
      expect(
        z
          .object({ message: z.string(), error: z.object({ message: z.string() }) })
          .parse(JSON.parse(String(record)))
      ).toEqual({ message: 'terminal failure', error: { message: 'original cause' } });
      expect(stderr).not.toHaveBeenCalled();
    }
  );

  it('contains a broken stderr fallback without retrying or logging recursively', () => {
    vi.mocked(appendFileSync).mockImplementation(() => {
      throw new Error('filesystem unavailable');
    });
    vi.mocked(writeSync).mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => createLogger('fatal-fallback').fatal('terminal failure')).not.toThrow();

    expect(appendFileSync).toHaveBeenCalledOnce();
    expect(writeSync).toHaveBeenCalledExactlyOnceWith(2, expect.any(Buffer), 0, expect.any(Number));
    expect(stderr).not.toHaveBeenCalled();
  });
  it('finishes short writes by byte offset without corrupting Unicode', () => {
    vi.mocked(appendFileSync).mockImplementation(() => {
      throw new Error('filesystem unavailable');
    });
    const pieces: Buffer[] = [];
    fallback.write.mockImplementation((_fd, bytes, offset, length) => {
      const written = Math.min(3, length);
      pieces.push(Buffer.from(bytes.subarray(offset, offset + written)));
      return written;
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    createLogger('fatal-fallback').fatal(
      'terminal failure 👋日本語',
      new Error('original cause 👋')
    );

    expect(fallback.write.mock.calls.length).toBeGreaterThan(1);
    const [, originalRecord] = vi.mocked(appendFileSync).mock.calls[0]!;
    expect(Buffer.concat(pieces)).toEqual(Buffer.from(String(originalRecord)));
    expect(
      z
        .object({ message: z.string(), error: z.object({ message: z.string() }) })
        .parse(JSON.parse(Buffer.concat(pieces).toString('utf8')))
    ).toEqual({ message: 'terminal failure 👋日本語', error: { message: 'original cause 👋' } });
    expect(appendFileSync).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([0, 2])('stops when stderr makes no progress after %s bytes', (progress) => {
    vi.mocked(appendFileSync).mockImplementation(() => {
      throw new Error('filesystem unavailable');
    });
    if (progress > 0) {
      fallback.write.mockReturnValueOnce(progress);
    }
    fallback.write.mockReturnValue(0);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => createLogger('fatal-fallback').fatal('terminal failure')).not.toThrow();

    expect(fallback.write).toHaveBeenCalledTimes(progress > 0 ? 2 : 1);
    expect(fallback.write.mock.calls.at(-1)?.[2]).toBe(progress);
    expect(appendFileSync).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });
});
