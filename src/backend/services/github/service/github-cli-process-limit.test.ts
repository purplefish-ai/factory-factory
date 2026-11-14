import { execFile } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { execCommand } from '@/backend/lib/shell';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/lib/shell', () => ({ execCommand: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  checkGithubAuth,
  getPRDescription,
  githubCLIService,
  submitCodeReview,
} from '@/backend/services/github';
import { GH_CONCURRENCY, ghExecLimit } from './github-cli/constants';

type Finish = () => void;
const pending: Finish[] = [];

function holdEveryProcess() {
  vi.mocked(execFile).mockImplementation(
    (() =>
      new Promise((resolve) => {
        pending.push(() => resolve({ stdout: 'body', stderr: '' }));
      })) as never
  );
  vi.mocked(execCommand).mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(() =>
          resolve({ code: 0, stdout: '', stderr: 'Logged in to github.com account octocat' })
        );
      })
  );
}

function started() {
  return vi.mocked(execFile).mock.calls.length + vi.mocked(execCommand).mock.calls.length;
}

afterEach(() => {
  for (const finish of pending.splice(0)) {
    finish();
  }
  vi.clearAllMocks();
  githubCLIService.clearCaches();
});

it('shares one limit of five gh processes across the CLI service, the auth check and review calls', async () => {
  holdEveryProcess();
  const reads = Array.from({ length: GH_CONCURRENCY }, (_, index) =>
    githubCLIService.getPRDiff('owner/repo', index + 1)
  );
  await vi.waitFor(() => expect(started()).toBe(GH_CONCURRENCY));

  const auth = checkGithubAuth();
  const description = getPRDescription('owner/repo', 99);
  const review = submitCodeReview('owner/repo', 99, {
    commitId: 'sha',
    body: 'Review',
    comments: [],
  });
  // Review submission writes its payload to a temporary file before it queues.
  await vi.waitFor(() => expect(ghExecLimit.pendingCount).toBe(3));
  expect(started()).toBe(GH_CONCURRENCY);
  expect(execCommand).not.toHaveBeenCalled();

  for (const waiting of [1, 2, 3]) {
    pending.shift()?.();
    await vi.waitFor(() => expect(started()).toBe(GH_CONCURRENCY + waiting));
  }
  for (const finish of pending.splice(0)) {
    finish();
  }
  await expect(auth).resolves.toEqual({ authenticated: true, user: 'octocat' });
  await expect(description).resolves.toBe('body');
  await expect(review).resolves.toBeUndefined();
  await Promise.all(reads);
});
