import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { githubCLIService } from './github-cli.service';

function comment(id: number, updatedAt: number = id) {
  return {
    id,
    user: { login: 'reviewer' },
    body: `Review ${id}`,
    path: 'src/index.ts',
    line: 1,
    created_at: new Date(id * 1000).toISOString(),
    updated_at: new Date(updatedAt * 1000).toISOString(),
    html_url: `https://github.com/owner/repo/pull/1#discussion_r${id}`,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

describe('review comment pagination', () => {
  it('keeps the latest activity, including edits to old comments, at the page cap', async () => {
    const comments = Array.from({ length: 2001 }, (_, index) => comment(index + 1));
    comments[0] = comment(1, 3000);
    vi.mocked(execFile).mockImplementation(((_command: string, args: string[]) => {
      const url = new URL(`https://api.github.com/${args[1]}`);
      const newestFirst =
        url.searchParams.get('sort') === 'updated' && url.searchParams.get('direction') === 'desc';
      const ordered = newestFirst
        ? [...comments].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        : comments;
      const page = Number(url.searchParams.get('page'));
      return Promise.resolve({
        stdout: JSON.stringify(ordered.slice((page - 1) * 100, page * 100)),
        stderr: '',
      });
    }) as never);

    const result = await githubCLIService.getReviewComments('owner/repo', 1);

    expect(execFile).toHaveBeenCalledTimes(20);
    expect(result).toHaveLength(2000);
    expect(result.map((entry) => entry.id)).toContain(2001);
    expect(result.map((entry) => entry.id)).toContain(1);
    expect(result.map((entry) => entry.id)).not.toContain(2);
    expect(result.at(-1)?.updatedAt).toBe(comments[0]?.updated_at);
  });

  it('retains the since filter while fetching newest updates first', async () => {
    vi.mocked(execFile).mockResolvedValue({ stdout: '[]', stderr: '' } as never);
    const since = new Date('2026-09-01T00:00:00Z');
    await githubCLIService.getReviewComments('owner/repo', 1, since);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['api', expect.stringContaining(`&since=${since.toISOString()}`)],
      expect.any(Object)
    );
  });
});
