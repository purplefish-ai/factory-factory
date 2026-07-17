import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

import { isProcessRunning } from './process-liveness';

describe('isProcessRunning', () => {
  beforeEach(() => {
    mockExecFileSync.mockReturnValue('S');
  });

  afterEach(() => vi.restoreAllMocks());

  it('treats zombie processes as dead', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mockExecFileSync.mockReturnValue('Z+');

    expect(isProcessRunning(123)).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ps',
      ['-o', 'stat=', '-p', '123'],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  it('treats permission-denied processes as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    expect(isProcessRunning(123)).toBe(true);
  });

  it('treats missing processes as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    expect(isProcessRunning(123)).toBe(false);
  });
});
