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

it('reads core metadata and conversation comments in one gh pr view', async () => {
  vi.mocked(execFile).mockResolvedValue({
    stdout: JSON.stringify({
      ...metadata,
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
  } as never);
  const controller = new AbortController();
  const result = await githubCLIService.getPRObservationDetails('org/repo', 42, controller.signal);
  expect(result).toMatchObject({
    headRefOid: 'head',
    reviewDecision: null,
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [
      expect.objectContaining({ name: 'build', conclusion: 'STARTUP_FAILURE' }),
      expect.objectContaining({ name: 'external', conclusion: 'SUCCESS' }),
    ],
    // gh does not export comment edit times; the creation time stands in.
    comments: [{ id: 'comment-1', updatedAt: metadata.updatedAt }],
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
      'number,title,url,updatedAt,isDraft,state,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName,mergeStateStatus,comments',
    ],
    expect.objectContaining({ signal: controller.signal, maxBuffer: 10 * 1024 * 1024 })
  );
});

it('does not couple core reads to unavailable review metadata', async () => {
  vi.mocked(execFile).mockImplementation(((_command: string, args: string[]) =>
    args[0] === 'api'
      ? Promise.reject(new Error('reviews unavailable'))
      : Promise.resolve({ stdout: JSON.stringify(metadata), stderr: '' })) as never);
  const signal = new AbortController().signal;
  await expect(githubCLIService.getPRReviews('org/repo', 42, signal)).rejects.toThrow(
    'reviews unavailable'
  );
  await expect(githubCLIService.getPRStatusDetails('org/repo', 42, signal)).resolves.toMatchObject({
    headRefOid: 'head',
  });
  for (const call of vi.mocked(execFile).mock.calls) {
    expect(call[2]).toMatchObject({ signal });
  }
});

it('preserves ordered review mapping', async () => {
  vi.mocked(execFile).mockResolvedValue({
    stdout: JSON.stringify([
      [
        {
          node_id: 'review-1',
          user: { login: 'reviewer' },
          state: 'CHANGES_REQUESTED',
          submitted_at: metadata.updatedAt,
          body: 'fix this',
        },
      ],
    ]),
    stderr: '',
  } as never);
  expect(await githubCLIService.getPRReviews('org/repo', 42)).toMatchObject([
    { id: 'review-1', chronologicalOrder: 0 },
  ]);
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    'gh',
    ['api', 'repos/org/repo/pulls/42/reviews?per_page=100', '--paginate', '--slurp'],
    expect.anything()
  );
});

it.each([
  { name: 'missing required fields', data: { number: 42 } },
  { name: 'wrong field types', data: { ...metadata, number: '42', isDraft: 'false' } },
  { name: 'invalid JSON', data: undefined },
])('rejects $name on the live core read', async ({ data }) => {
  vi.mocked(execFile).mockResolvedValue({
    stdout: data === undefined ? 'not valid json{' : JSON.stringify(data),
    stderr: '',
  } as never);
  await expect(githubCLIService.getPRStatusDetails('org/repo', 42)).rejects.toThrow(
    /(?:Invalid gh CLI response|Failed to parse gh CLI JSON) for getPRStatusDetails/
  );
});

it('propagates rate limits and prevents another core read during backoff', async () => {
  const rateLimitError = new Error('HTTP 429 rate limit exceeded');
  vi.mocked(execFile).mockRejectedValue(rateLimitError as never);
  await expect(githubCLIService.getPRStatusDetails('org/repo', 42)).rejects.toBe(rateLimitError);
  await expect(githubCLIService.getPRStatusDetails('org/repo', 43)).rejects.toThrow(
    'GitHub API rate limit exceeded, backing off'
  );
  expect(execFile).toHaveBeenCalledTimes(1);
});
