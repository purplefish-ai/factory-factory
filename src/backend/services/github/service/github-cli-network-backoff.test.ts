import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execute, logger } = vi.hoisted(() => ({
  execute: vi.fn(),
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('node:child_process', () => ({ execFile: execute }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logger }));

import { githubCLIService } from './github-cli.service';

const offline = new Error(
  'Command failed: gh pr view 1 --repo org/repo\nerror connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n'
);
const details = {
  number: 1,
  title: 'PR',
  url: 'https://github.com/org/repo/pull/1',
  updatedAt: '2026-10-28T12:00:00Z',
  isDraft: false,
  state: 'OPEN',
  reviewDecision: null,
  statusCheckRollup: [],
  headRefOid: 'abc',
  headRefName: 'feature',
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN',
};

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});
afterEach(() => vi.restoreAllMocks());

it('shares a bounded network cooldown across PRs and resumes reads after it expires', async () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  execute.mockRejectedValueOnce(offline).mockResolvedValue({
    stdout: JSON.stringify(details),
    stderr: '',
  });
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).rejects.toBe(offline);
  now += 20_000;
  await expect(githubCLIService.getPRStatusDetails('other/repo', 2)).rejects.toBe(offline);
  expect(execute).toHaveBeenCalledTimes(1);
  now += 10_000;
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).resolves.toMatchObject({
    number: 1,
    state: 'OPEN',
  });
  expect(execute).toHaveBeenCalledTimes(2);
});

it('rechecks network backoff before spawning reads already waiting for a process slot', async () => {
  const pending: Array<(error: Error) => void> = [];
  execute.mockImplementation(() =>
    pending.length >= 5
      ? Promise.reject(offline)
      : new Promise((_resolve, reject) => pending.push(reject))
  );
  const requests = Array.from({ length: 8 }, (_, index) =>
    githubCLIService.getPRStatusDetails('org/repo', index + 1, new AbortController().signal)
  );
  const settled = Promise.allSettled(requests);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(5));
  for (const reject of pending) {
    reject(offline);
  }
  expect(await settled).toEqual(
    Array.from({ length: 8 }, () => ({ status: 'rejected', reason: offline }))
  );
  expect(execute).toHaveBeenCalledTimes(5);
});

it('keeps unknown failures retryable without starting a network cooldown', async () => {
  execute.mockRejectedValueOnce(new Error('invalid response')).mockResolvedValueOnce({
    stdout: JSON.stringify(details),
    stderr: '',
  });
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).rejects.toThrow(
    'invalid response'
  );
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).resolves.toMatchObject({
    number: 1,
  });
});

it('does not turn a cancelled read into a process-wide network outage', async () => {
  const controller = new AbortController();
  execute
    .mockImplementationOnce(() => {
      controller.abort(offline);
      return Promise.reject(offline);
    })
    .mockResolvedValueOnce({ stdout: JSON.stringify(details), stderr: '' });
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1, controller.signal)).rejects.toBe(
    offline
  );
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).resolves.toMatchObject({
    number: 1,
  });
});

it('does not block or automatically replay writes during a read network cooldown', async () => {
  execute.mockRejectedValueOnce(offline).mockResolvedValueOnce({ stdout: '', stderr: '' });
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).rejects.toBe(offline);
  await githubCLIService.submitReview('org/repo', 1, 'approve');
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenLastCalledWith(
    'gh',
    expect.arrayContaining(['review', '--approve']),
    expect.any(Object)
  );
});

it('clears the network cooldown with the other CLI caches', async () => {
  execute
    .mockRejectedValueOnce(offline)
    .mockResolvedValueOnce({ stdout: JSON.stringify(details), stderr: '' });
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).rejects.toBe(offline);
  githubCLIService.clearCaches();
  await expect(githubCLIService.getPRStatusDetails('org/repo', 1)).resolves.toMatchObject({
    number: 1,
  });
});
