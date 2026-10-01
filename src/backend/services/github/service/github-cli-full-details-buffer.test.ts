import { type ExecFileOptions, execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { githubCLIService } from './github-cli.service';

const realChildProcess =
  await vi.importActual<typeof import('node:child_process')>('node:child_process');
const realUtil = await vi.importActual<typeof import('node:util')>('node:util');
const execFixture = realUtil.promisify(realChildProcess.execFile);
let fixtureDirectory: string;
let fixturePath: string;

function fullDetailsFixture() {
  const timestamp = '2026-09-01T00:00:00Z';
  return {
    number: 123,
    title: 'Large PR',
    url: 'https://github.com/owner/repo/pull/123',
    author: { login: 'author' },
    createdAt: timestamp,
    updatedAt: timestamp,
    isDraft: false,
    state: 'OPEN',
    reviewDecision: 'APPROVED',
    reviews: Array.from({ length: 200 }, (_, index) => ({
      id: `review-${index}`,
      author: { login: 'reviewer' },
      state: 'APPROVED',
      submittedAt: timestamp,
      body: 'r'.repeat(4096),
    })),
    comments: Array.from({ length: 200 }, (_, index) => ({
      id: `comment-${index}`,
      author: { login: 'commenter' },
      body: 'c'.repeat(3072),
      createdAt: timestamp,
      updatedAt: timestamp,
      url: `https://github.com/owner/repo/pull/123#issuecomment-${index}`,
    })),
    statusCheckRollup: Array.from({ length: 50 }, (_, index) => ({
      __typename: 'CheckRun',
      name: `check-${index}`,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
    })),
    labels: [{ name: 'bug', color: 'ff0000' }],
    additions: 100,
    deletions: 10,
    changedFiles: 5,
    headRefName: 'feature',
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
  };
}

beforeEach(async () => {
  githubCLIService.clearCaches();
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'gh-full-details-'));
  fixturePath = join(fixtureDirectory, 'pr.json');
  // Replace only the external gh executable. Keep Node's real stdout buffering,
  // promisify behavior, and the service's parsing and mapping intact.
  vi.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    options: ExecFileOptions
  ) => {
    expect(command).toBe('gh');
    expect(args.slice(0, 3)).toEqual(['pr', 'view', '123']);
    return execFixture(
      process.execPath,
      ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", fixturePath],
      options
    );
  }) as never);
});

afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('full PR details stdout buffering', () => {
  it.each([false, true])(
    'loads all metadata beyond 1 MiB (with signal: %s)',
    async (withSignal) => {
      const payload = JSON.stringify(fullDetailsFixture());
      expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);
      await writeFile(fixturePath, payload);

      const result = await githubCLIService.getPRFullDetails(
        'owner/repo',
        123,
        withSignal ? new AbortController().signal : undefined
      );

      expect(result.number).toBe(123);
      expect(result.reviews).toHaveLength(200);
      expect(result.reviews.at(-1)).toMatchObject({ id: 'review-199', body: 'r'.repeat(4096) });
      expect(result.comments).toHaveLength(200);
      expect(result.comments.at(-1)).toMatchObject({ id: 'comment-199', body: 'c'.repeat(3072) });
      expect(result.statusCheckRollup).toHaveLength(50);
      expect(result.statusCheckRollup?.at(-1)).toMatchObject({
        name: 'check-49',
        conclusion: 'SUCCESS',
      });
      expect(result.labels).toEqual([{ name: 'bug', color: 'ff0000' }]);
      expect(result.headRefName).toBe('feature');
    }
  );

  it('still rejects stdout beyond the bounded bulk-payload buffer', async () => {
    const fixture = fullDetailsFixture();
    fixture.title = 't'.repeat(11 * 1024 * 1024);
    await writeFile(fixturePath, JSON.stringify(fixture));

    await expect(githubCLIService.getPRFullDetails('owner/repo', 123)).rejects.toThrow(
      'stdout maxBuffer length exceeded'
    );
  });
});
