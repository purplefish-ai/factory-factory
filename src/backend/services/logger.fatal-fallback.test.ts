import { appendFileSync, mkdirSync, writeSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLogger } from './logger.service';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  writeSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
  createWriteStream: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

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

      expect(writeSync).toHaveBeenCalledExactlyOnceWith(2, expect.any(String));
      const [, record] = vi.mocked(writeSync).mock.calls[0]!;
      expect(record).toEqual(expect.stringMatching(/\n$/));
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
    expect(writeSync).toHaveBeenCalledExactlyOnceWith(2, expect.any(String));
    expect(stderr).not.toHaveBeenCalled();
  });
});
