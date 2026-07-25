import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExec = vi.fn();

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
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

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
