import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { githubCLIService } from './github-cli.service';

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

it('excludes archived repositories on every page of review requests', async () => {
  const read = vi.fn();
  vi.mocked(execFile).mockImplementation(read);
  for (const number of [1, 2]) {
    read.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: number === 1, endCursor: `cursor-${number}` },
            nodes: [
              {
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
              },
            ],
          },
        },
      }),
      stderr: '',
    });
  }

  expect((await githubCLIService.listReviewRequests()).map((pr) => pr.number)).toEqual([1, 2]);
  expect(read).toHaveBeenCalledTimes(2);
  for (const call of read.mock.calls) {
    expect(call[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('is:pr is:open review-requested:@me archived:false'),
      ])
    );
  }
  expect(read.mock.calls[1]?.[1]).toEqual(
    expect.arrayContaining([expect.stringContaining('after: "cursor-1"')])
  );
});
