import { execFile } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { githubCLIService } from './github-cli.service';
import { REVIEW_REQUEST_CACHE_TTL_MS } from './github-cli/review-request-cache';

let now = 0;

function searchPage(...numbers: number[]) {
  return {
    stdout: JSON.stringify({
      data: {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: numbers.map((number) => ({
            number,
            title: `PR ${number}`,
            url: `https://github.com/o/r/pull/${number}`,
            repository: { nameWithOwner: 'o/r' },
            author: { login: 'alice' },
            createdAt: '2026-01-10T00:00:00Z',
            isDraft: false,
            reviewDecision: 'REVIEW_REQUIRED',
            additions: 1,
            deletions: 0,
            changedFiles: 1,
          })),
        },
      },
    }),
    stderr: '',
  };
}

const numbers = async (repository?: string, options?: { forceRefresh?: boolean }) =>
  (await githubCLIService.listReviewRequests(repository, options)).map((pr) => pr.number);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('serves repeated polls from one search per repository until the entry is stale', async () => {
  vi.mocked(execFile)
    .mockResolvedValueOnce(searchPage(1) as never)
    .mockResolvedValueOnce(searchPage(9) as never);

  expect(await numbers('o/r')).toEqual([1]);
  now = REVIEW_REQUEST_CACHE_TTL_MS - 1;
  expect(await numbers('O/R')).toEqual([1]);
  expect(await numbers('o/r')).toEqual([1]);
  expect(execFile).toHaveBeenCalledTimes(1);

  // Another repository and the global search are cached separately.
  expect(await numbers()).toEqual([9]);
  expect(execFile).toHaveBeenCalledTimes(2);
});

it('returns the stale entry while one background search refreshes it', async () => {
  const refreshed = deferred<unknown>();
  vi.mocked(execFile)
    .mockResolvedValueOnce(searchPage(1) as never)
    .mockReturnValueOnce(refreshed.promise as never);

  await numbers('o/r');
  now = REVIEW_REQUEST_CACHE_TTL_MS;
  expect(await numbers('o/r')).toEqual([1]);
  expect(await numbers('o/r')).toEqual([1]);
  expect(execFile).toHaveBeenCalledTimes(2);

  refreshed.resolve(searchPage(1, 2));
  await vi.waitFor(async () => expect(await numbers('o/r')).toEqual([1, 2]));
  expect(execFile).toHaveBeenCalledTimes(2);
});

it('keeps the stale entry when a background search fails and retries on the next read', async () => {
  vi.mocked(execFile)
    .mockResolvedValueOnce(searchPage(1) as never)
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(searchPage(3) as never);

  await numbers('o/r');
  now = REVIEW_REQUEST_CACHE_TTL_MS;
  expect(await numbers('o/r')).toEqual([1]);
  await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await numbers('o/r')).toEqual([1]);
  await vi.waitFor(async () => expect(await numbers('o/r')).toEqual([3]));
});

it('searches again for an explicit refresh even when the entry is fresh', async () => {
  vi.mocked(execFile)
    .mockResolvedValueOnce(searchPage(1) as never)
    .mockResolvedValueOnce(searchPage(2) as never);

  await numbers('o/r');
  expect(await numbers('o/r', { forceRefresh: true })).toEqual([2]);
  expect(await numbers('o/r')).toEqual([2]);
  expect(execFile).toHaveBeenCalledTimes(2);
});

it('drops cached requests after a submitted review, including searches already running', async () => {
  const running = deferred<unknown>();
  vi.mocked(execFile)
    .mockResolvedValueOnce(searchPage(1) as never)
    .mockReturnValueOnce(running.promise as never)
    .mockResolvedValueOnce({ stdout: '', stderr: '' } as never)
    .mockResolvedValueOnce(searchPage(2) as never);

  await numbers('o/r');
  now = REVIEW_REQUEST_CACHE_TTL_MS;
  await numbers('o/r'); // starts a background search that predates the review
  await githubCLIService.submitReview('o/r', 1, 'approve');

  const afterReview = numbers('o/r');
  running.resolve(searchPage(1));
  expect(await afterReview).toEqual([2]);
  expect(await numbers('o/r')).toEqual([2]);
  expect(vi.mocked(execFile).mock.calls[2]?.[1]).toEqual(
    expect.arrayContaining(['review', '--approve'])
  );
  expect(execFile).toHaveBeenCalledTimes(4);
});
