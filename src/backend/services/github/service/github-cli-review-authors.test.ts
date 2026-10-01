import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { reviewCommentSchema } from './github-cli/schemas';
import { githubCLIService } from './github-cli.service';

function comment(id: number, user: { login: string } | null = { login: 'reviewer' }) {
  return {
    id,
    user,
    body: `Review ${id}`,
    path: 'src/index.ts',
    line: null,
    created_at: new Date(id * 1000).toISOString(),
    updated_at: new Date(id * 1000).toISOString(),
    html_url: `https://github.com/owner/repo/pull/1#discussion_r${id}`,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

describe('review comment authors', () => {
  it('accepts an explicitly null user from a deleted account', () => {
    expect(reviewCommentSchema.parse(comment(1, null)).user).toBeNull();
  });

  it.each([undefined, {}, { login: null }, { login: 123 }])(
    'still rejects malformed users: %j',
    (user) => {
      expect(reviewCommentSchema.safeParse({ ...comment(1), user }).success).toBe(false);
    }
  );

  it('preserves feedback and named attribution across pages containing deleted authors', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => comment(101 - index));
    firstPage[0] = comment(101, { login: 'named-reviewer' });
    firstPage[99] = comment(2, null);
    vi.mocked(execFile)
      .mockResolvedValueOnce({ stdout: JSON.stringify(firstPage), stderr: '' } as never)
      .mockResolvedValueOnce({ stdout: JSON.stringify([comment(1)]), stderr: '' } as never);

    const result = await githubCLIService.getReviewComments('owner/repo', 1);

    expect(result).toHaveLength(101);
    expect(result.map((entry) => entry.id)).toEqual(
      Array.from({ length: 101 }, (_, index) => index + 1)
    );
    expect(result[0]?.author.login).toBe('reviewer');
    expect(result.at(-1)?.author.login).toBe('named-reviewer');
    expect(result[1]).toEqual({
      id: 2,
      author: { login: '' },
      body: 'Review 2',
      path: 'src/index.ts',
      line: null,
      createdAt: new Date(2000).toISOString(),
      updatedAt: new Date(2000).toISOString(),
      url: 'https://github.com/owner/repo/pull/1#discussion_r2',
    });
  });
});
