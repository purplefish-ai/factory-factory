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
