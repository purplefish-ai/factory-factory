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

it('trusts a healthy result for minutes but rechecks an unhealthy one after 30 seconds', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  mockExecFile.mockResolvedValue({ stdout: 'gh version 2.20.0', stderr: '' });
  await githubCLIService.checkHealth();
  now.mockReturnValue(5 * 60_000 - 1);
  await githubCLIService.checkHealth();
  expect(mockExecFile).toHaveBeenCalledTimes(2);

  githubCLIService.clearCaches();
  mockExecFile
    .mockReset()
    .mockResolvedValueOnce({ stdout: 'gh version 2.20.0', stderr: '' })
    .mockRejectedValueOnce(new Error('not logged in'))
    .mockResolvedValue({ stdout: 'gh version 2.20.0', stderr: '' });
  now.mockReturnValue(0);
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(false);
  now.mockReturnValue(30_000);
  // Stale-while-revalidate: the stale answer returns while the recheck runs.
  expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(false);
  await vi.waitFor(async () =>
    expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(true)
  );
  now.mockRestore();
});

it('rechecks a healthy result after a gh read reports missing authentication', async () => {
  mockExecFile.mockResolvedValue({ stdout: 'gh version 2.20.0', stderr: '' });
  await githubCLIService.checkHealth();

  mockExecFile
    .mockRejectedValueOnce(
      Object.assign(new Error('Command failed'), { stderr: 'To get started, run: gh auth login' })
    )
    .mockResolvedValueOnce({ stdout: 'gh version 2.20.0', stderr: '' })
    .mockRejectedValueOnce(new Error('not logged in'));
  await expect(githubCLIService.getPRPreview('o/r', 1)).rejects.toThrow();
  await githubCLIService.checkHealth();
  await vi.waitFor(async () =>
    expect((await githubCLIService.checkHealth()).isAuthenticated).toBe(false)
  );
  expect(mockExecFile).toHaveBeenCalledTimes(5);
});

it('keeps a healthy result after unrelated gh read failures', async () => {
  mockExecFile.mockResolvedValue({ stdout: 'gh version 2.20.0', stderr: '' });
  await githubCLIService.checkHealth();
  mockExecFile.mockRejectedValueOnce(
    Object.assign(new Error('Command failed'), { stderr: 'HTTP 404: Not Found' })
  );
  await expect(githubCLIService.getPRPreview('o/r', 1)).rejects.toThrow();
  await githubCLIService.checkHealth();
  expect(mockExecFile).toHaveBeenCalledTimes(3);
});
