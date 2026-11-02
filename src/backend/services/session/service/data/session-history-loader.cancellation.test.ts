import { beforeEach, expect, it, vi } from 'vitest';
import { claudeSessionHistoryLoaderService } from './session-history-loader.service';

const fs = vi.hoisted(() => ({ access: vi.fn(), readdir: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => fs);

beforeEach(() => {
  vi.resetAllMocks();
  fs.access.mockRejectedValue(new Error('missing'));
  fs.readdir.mockResolvedValue(['first', 'second']);
  fs.stat.mockResolvedValue({ isDirectory: () => true });
});

it.each(['before lookup', 'after direct lookup', 'after directory listing', 'during scan'])(
  'stops a stale Claude fallback %s without probing more directories',
  async (boundary) => {
    let current = boundary !== 'before lookup';
    if (boundary === 'after direct lookup') {
      fs.access.mockImplementationOnce(() => {
        current = false;
        return Promise.reject(new Error('missing'));
      });
    }
    if (boundary === 'after directory listing') {
      fs.readdir.mockImplementationOnce(() => {
        current = false;
        return Promise.resolve(['first', 'second']);
      });
    }
    if (boundary === 'during scan') {
      fs.stat.mockImplementationOnce(() => {
        current = false;
        return Promise.resolve({ isDirectory: () => true });
      });
    }
    await expect(
      claudeSessionHistoryLoaderService.loadSessionHistory({
        providerSessionId: 'history',
        workingDir: '/work',
        isCurrent: () => current,
      })
    ).resolves.toEqual({ status: 'not_found' });
    expect(fs.access).toHaveBeenCalledTimes(boundary === 'before lookup' ? 0 : 1);
    expect(fs.readdir).toHaveBeenCalledTimes(
      ['before lookup', 'after direct lookup'].includes(boundary) ? 0 : 1
    );
    expect(fs.stat).toHaveBeenCalledTimes(boundary === 'during scan' ? 1 : 0);
  }
);
