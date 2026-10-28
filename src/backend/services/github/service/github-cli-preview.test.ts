import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
import { githubCLIService } from './github-cli.service';

const preview = {
  title: 'Show PR previews',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'martin' },
  createdAt: '2026-10-28T12:00:00Z',
  additions: 24,
  deletions: 3,
  changedFiles: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

it('fetches a small preview without reviews, comments, checks, or diffs', async () => {
  vi.mocked(execFile).mockResolvedValue({ stdout: JSON.stringify(preview), stderr: '' } as never);
  await expect(githubCLIService.getPRPreview('owner/repo', 42)).resolves.toEqual(preview);
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    'gh',
    [
      'pr',
      'view',
      '42',
      '--repo',
      'owner/repo',
      '--json',
      'title,state,isDraft,author,createdAt,additions,deletions,changedFiles',
    ],
    expect.any(Object)
  );
});

it('allows a deleted author and rejects malformed preview metadata', async () => {
  vi.mocked(execFile).mockResolvedValue({
    stdout: JSON.stringify({ ...preview, author: null }),
    stderr: '',
  } as never);
  await expect(githubCLIService.getPRPreview('owner/repo', 42)).resolves.toMatchObject({
    author: null,
  });
  vi.mocked(execFile).mockResolvedValue({
    stdout: JSON.stringify({ ...preview, additions: '24' }),
    stderr: '',
  } as never);
  await expect(githubCLIService.getPRPreview('owner/repo', 43)).rejects.toThrow(
    'Invalid gh CLI response'
  );
});
