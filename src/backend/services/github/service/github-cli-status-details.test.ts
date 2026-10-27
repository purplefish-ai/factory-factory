import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
import { githubCLIService } from './github-cli.service';

const metadata = {
  number: 42,
  title: 'PR',
  url: 'https://github.com/org/repo/pull/42',
  updatedAt: '2026-01-01T00:00:00Z',
  isDraft: false,
  state: 'OPEN',
  reviewDecision: '',
  statusCheckRollup: [
    { name: 'build', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
    { context: 'external', state: 'SUCCESS', targetUrl: 'https://ci.example/build/42' },
  ],
  headRefOid: 'head',
  headRefName: 'feature',
  baseRefName: 'main',
  mergeStateStatus: 'DIRTY',
};

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

it('reads and validates core metadata without any review or conversation fetch', async () => {
  vi.mocked(execFile).mockResolvedValue({ stdout: JSON.stringify(metadata), stderr: '' } as never);
  const controller = new AbortController();
  const result = await githubCLIService.getPRStatusDetails('org/repo', 42, controller.signal);
  expect(result).toMatchObject({
    headRefOid: 'head',
    reviewDecision: null,
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [
      expect.objectContaining({ name: 'build', conclusion: 'STARTUP_FAILURE' }),
      expect.objectContaining({
        name: 'external',
        detailsUrl: 'https://ci.example/build/42',
        conclusion: 'SUCCESS',
      }),
    ],
  });
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    'gh',
    [
      'pr',
      'view',
      '42',
      '--repo',
      'org/repo',
      '--json',
      'number,title,url,updatedAt,isDraft,state,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName,mergeStateStatus',
    ],
    expect.objectContaining({ signal: controller.signal, maxBuffer: 10 * 1024 * 1024 })
  );
  expect(result).not.toHaveProperty('reviews');
  expect(result).not.toHaveProperty('comments');
});

it('rejects malformed core data instead of defaulting a check result to success', async () => {
  vi.mocked(execFile).mockResolvedValue({
    stdout: JSON.stringify({ ...metadata, statusCheckRollup: [{ name: 'broken' }] }),
    stderr: '',
  } as never);
  await expect(githubCLIService.getPRStatusDetails('org/repo', 42)).rejects.toThrow();
});

it.each(['reviews', 'comments'])(
  'does not couple core reads to unavailable %s metadata',
  async (failure) => {
    vi.mocked(execFile).mockImplementation(((_command: string, args: string[]) => {
      if (args[0] === 'api') {
        return failure === 'reviews'
          ? Promise.reject(new Error('reviews unavailable'))
          : Promise.resolve({ stdout: '[[]]', stderr: '' });
      }
      if (args.at(-1) === 'updatedAt,comments') {
        return failure === 'comments'
          ? Promise.reject(new Error('comments unavailable'))
          : Promise.resolve({
              stdout: JSON.stringify({ updatedAt: metadata.updatedAt, comments: [] }),
              stderr: '',
            });
      }
      return Promise.resolve({ stdout: JSON.stringify(metadata), stderr: '' });
    }) as never);
    const signal = new AbortController().signal;
    await expect(githubCLIService.getPRReviewDetails('org/repo', 42, signal)).rejects.toThrow(
      `${failure} unavailable`
    );
    await expect(
      githubCLIService.getPRStatusDetails('org/repo', 42, signal)
    ).resolves.toMatchObject({ headRefOid: 'head' });
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[2]).toMatchObject({ signal });
    }
  }
);

it('preserves ordered review mapping and conversation timestamp fallback', async () => {
  vi.mocked(execFile).mockImplementation(((_command: string, args: string[]) =>
    Promise.resolve({
      stdout:
        args[0] === 'api'
          ? JSON.stringify([
              [
                {
                  node_id: 'review-1',
                  user: { login: 'reviewer' },
                  state: 'CHANGES_REQUESTED',
                  submitted_at: metadata.updatedAt,
                  body: 'fix this',
                },
              ],
            ])
          : JSON.stringify({
              updatedAt: metadata.updatedAt,
              comments: [
                {
                  id: 'comment-1',
                  author: { login: 'me' },
                  body: 'summary',
                  createdAt: metadata.updatedAt,
                  url: metadata.url,
                },
              ],
            }),
      stderr: '',
    })) as never);
  expect(await githubCLIService.getPRReviewDetails('org/repo', 42)).toMatchObject({
    reviews: [{ id: 'review-1', chronologicalOrder: 0 }],
    comments: [{ id: 'comment-1', updatedAt: metadata.updatedAt }],
  });
});
