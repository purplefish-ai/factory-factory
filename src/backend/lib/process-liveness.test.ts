import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPsState = vi.hoisted(() => vi.fn<() => string>());
const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout: mockPsState(), stderr: '' });
    }
  )
);

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { isProcessRunning } from './process-liveness';

describe('isProcessRunning', () => {
  beforeEach(() => {
    mockPsState.mockReturnValue('S');
  });

  afterEach(() => vi.restoreAllMocks());

  it('treats zombie processes as dead', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mockPsState.mockReturnValue('Z+');

    await expect(isProcessRunning(123)).resolves.toBe(false);
    expect(mockExecFile).toHaveBeenCalledWith(
      'ps',
      ['-o', 'stat=', '-p', '123'],
      expect.objectContaining({ encoding: 'utf8' }),
      expect.any(Function)
    );
  });

  it('treats live non-zombie processes as running', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);

    await expect(isProcessRunning(123)).resolves.toBe(true);
  });

  it('keeps a live PID when its state lookup fails', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mockExecFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(new Error('ps unavailable'), { stdout: '', stderr: '' });
    });

    await expect(isProcessRunning(123)).resolves.toBe(true);
  });

  it('treats permission-denied processes as alive', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    await expect(isProcessRunning(123)).resolves.toBe(true);
  });

  it('treats missing processes as dead', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    await expect(isProcessRunning(123)).resolves.toBe(false);
  });
});
