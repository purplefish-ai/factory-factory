import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: execFileAsync }),
}));

import { submitCodeReview } from './code-review';

const input = { commitId: 'abc123', body: 'Summary-only finding', comments: [] };

describe('submitCodeReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits summary-only findings as a COMMENT review', async () => {
    execFileAsync.mockImplementation(async (_command, args: string[]) => {
      const payload: unknown = JSON.parse(await readFile(args[args.length - 1]!, 'utf8'));
      expect(payload).toEqual({
        commit_id: 'abc123',
        body: input.body,
        event: 'COMMENT',
        comments: [],
      });
      return { stdout: '', stderr: '' };
    });
    await expect(submitCodeReview('example/repo', 1, input)).resolves.toBeUndefined();
    expect(execFileAsync).toHaveBeenCalledExactlyOnceWith(
      'gh',
      [
        'api',
        '--method',
        'POST',
        'repos/example/repo/pulls/1/reviews',
        '--input',
        expect.any(String),
      ],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('maps inline comments into the submitted COMMENT review payload', async () => {
    const comments = [{ path: 'file.ts', line: 7, side: 'RIGHT' as const, body: 'Inline finding' }];
    execFileAsync.mockImplementation(async (_command, args: string[]) => {
      const payload: unknown = JSON.parse(await readFile(args[args.length - 1]!, 'utf8'));
      expect(payload).toEqual({
        commit_id: 'abc123',
        body: input.body,
        event: 'COMMENT',
        comments,
      });
      return { stdout: '', stderr: '' };
    });
    await submitCodeReview('example/repo', 1, { ...input, comments });
    expect(execFileAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    'gh: Validation Failed (HTTP 422)',
    'gh: Review comments is invalid (HTTP 422)',
    'gh: API rate limit exceeded (HTTP 403)',
    'timeout',
    'Can not approve your own pull request',
  ])('does not classify an unrelated failure as a self-review rejection: %s', async (message) => {
    execFileAsync.mockRejectedValue(new Error(message));
    await expect(submitCodeReview('example/repo', 1, input)).rejects.toMatchObject({
      isSelfReviewRejection: false,
    });
  });

  it.each([
    'Can not approve your own pull request',
    'Can not request changes on your own pull request',
  ])('recognizes an explicit self-review validation error in gh stdout: %s', async (message) => {
    execFileAsync.mockRejectedValue(
      Object.assign(new Error('gh: Validation Failed (HTTP 422)'), {
        stdout: JSON.stringify({ message: 'Validation Failed', errors: [message] }),
        stderr: 'gh: Validation Failed (HTTP 422)',
      })
    );
    await expect(submitCodeReview('example/repo', 1, input)).rejects.toMatchObject({
      isSelfReviewRejection: true,
    });
  });

  it('recognizes the explicit rejection when gh includes it in stderr', async () => {
    execFileAsync.mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        stderr: 'gh: Can not request changes on your own pull request (HTTP 422)',
      })
    );
    await expect(submitCodeReview('example/repo', 1, input)).rejects.toMatchObject({
      isSelfReviewRejection: true,
    });
  });
});
