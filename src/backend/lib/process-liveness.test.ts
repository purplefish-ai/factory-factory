import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProcessRunning } from './process-liveness';

describe('isProcessRunning', () => {
  afterEach(() => vi.restoreAllMocks());

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
