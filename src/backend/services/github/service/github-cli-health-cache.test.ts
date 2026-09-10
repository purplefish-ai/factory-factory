import { beforeEach, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { githubCLIService } from './github-cli.service';

beforeEach(() => {
  mockExecFile.mockReset();
  githubCLIService.clearCaches();
});

it('refreshes cached authentication immediately when explicitly requested', async () => {
  mockExecFile
    .mockResolvedValueOnce({ stdout: 'gh version 2.20.0', stderr: '' })
    .mockRejectedValueOnce(new Error('not logged in'));
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(false);

  mockExecFile.mockResolvedValue({ stdout: 'gh version 2.20.0', stderr: '' });
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(false);
  expect((await githubCLIService.checkHealth(true)).isAuthenticated).toBe(true);
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(true);
});

it('waits for pre-login background checks before forcing a new authentication check', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  mockExecFile
    .mockResolvedValueOnce({ stdout: 'gh version 2.20.0', stderr: '' })
    .mockRejectedValueOnce(new Error('not logged in'));
  await githubCLIService.checkHealth();

  let rejectOldAuth!: (error: Error) => void;
  mockExecFile
    .mockResolvedValueOnce({ stdout: 'gh version 2.20.0', stderr: '' })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldAuth = reject;
        })
    )
    .mockResolvedValue({ stdout: 'gh version 2.20.0', stderr: '' });
  now.mockReturnValue(30_001);
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(false);
  await vi.waitFor(() => expect(rejectOldAuth).toBeTypeOf('function'));
  const forced = githubCLIService.checkHealth(true);
  // Let the forced check reach the old in-flight auth process before it settles.
  await new Promise<void>((resolve) => setImmediate(resolve));
  rejectOldAuth(new Error('pre-login result'));
  expect((await forced).isAuthenticated).toBe(true);
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(true);
});
