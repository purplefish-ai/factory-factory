import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExec = vi.fn();
const mockServer = { once: vi.fn(), listen: vi.fn(), close: vi.fn() };

vi.mock('node:net', () => ({ createServer: () => mockServer }));

vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { findAvailablePort } from './runtime-utils';

describe('findAvailablePort', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockReset();
    mockServer.once.mockReset();
    mockServer.listen.mockReset();
    mockServer.close.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  it('skips a hidden listener when lsof exits 1', async () => {
    mockExec.mockRejectedValue(Object.assign(new Error('No visible listeners'), { code: 1 }));
    let attempt = 0;
    mockServer.once.mockImplementation((event: string, callback: () => void) => {
      if ((attempt === 0 && event === 'error') || (attempt === 1 && event === 'listening')) {
        queueMicrotask(callback);
      }
      return mockServer;
    });
    mockServer.listen.mockImplementation(() => {
      attempt += 1;
    });
    mockServer.close.mockImplementation((callback: () => void) => callback());

    await expect(findAvailablePort(3000)).resolves.toBe(3001);
    expect(mockServer.listen.mock.calls).toEqual([[3000], [3001]]);
    expect(mockServer.close).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it.each([0, -1, 65_536, 1.5])(
    'rejects invalid start port %s before probing',
    async (startPort) => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '' });

      await expect(findAvailablePort(startPort)).rejects.toThrow(
        `Invalid start port ${startPort}: expected an integer between 1 and 65535`
      );

      expect(mockExec).not.toHaveBeenCalled();
    }
  );

  it('does not probe ports above the valid TCP range', async () => {
    mockExec.mockResolvedValue({ stdout: '12345\n', stderr: '' });

    await expect(findAvailablePort(65_535)).rejects.toThrow(
      'Could not find an available port starting from 65535'
    );

    expect(mockExec).toHaveBeenCalledOnce();
    expect(mockExec).toHaveBeenCalledWith('lsof -i :65535 -sTCP:LISTEN -t', {
      timeout: 2000,
    });
  });
});
