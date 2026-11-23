import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
import { githubCLIService } from './github-cli.service';

const ghIssue = {
  number: 2,
  title: 'Issue 2',
  body: 'x'.repeat(10_000),
  url: 'https://github.com/o/r/issues/2',
  state: 'OPEN',
  createdAt: '2026-02-01T00:00:00Z',
  author: { id: 'MDQ6', is_bot: false, login: 'bob', name: 'Bob' },
};
const listItem = {
  number: 2,
  title: 'Issue 2',
  url: 'https://github.com/o/r/issues/2',
  createdAt: '2026-02-01T00:00:00Z',
  author: { login: 'bob' },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  githubCLIService.clearCaches();
});

// The Kanban board polls this list, and a body can be kilobytes per issue.
it('lists issues without bodies or any field the issue lists do not render', async () => {
  vi.mocked(execFile).mockResolvedValue({ stdout: JSON.stringify([ghIssue]), stderr: '' } as never);

  await expect(githubCLIService.listIssues('o', 'r', { assignee: '@me' })).resolves.toStrictEqual([
    listItem,
  ]);
  const args = vi.mocked(execFile).mock.calls[0]?.[1] as string[];
  expect(args[args.indexOf('--json') + 1]).toBe('number,title,url,createdAt,author');
});

it('serves polls from the list cache, one gh process per refresh', async () => {
  vi.useFakeTimers();
  vi.mocked(execFile).mockResolvedValue({ stdout: JSON.stringify([ghIssue]), stderr: '' } as never);

  await githubCLIService.listIssues('o', 'r', { assignee: '@me' });
  await expect(githubCLIService.listIssues('o', 'r', { assignee: '@me' })).resolves.toStrictEqual([
    listItem,
  ]);
  expect(execFile).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(60_000);
  await expect(githubCLIService.listIssues('o', 'r', { assignee: '@me' })).resolves.toStrictEqual([
    listItem,
  ]);
  expect(execFile).toHaveBeenCalledTimes(2);
});
