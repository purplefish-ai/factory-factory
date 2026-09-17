/**
 * Posting an adversarial-review finding as a real GitHub PR review (a summary
 * plus inline comments anchored to diff lines).
 *
 * Kept separate from `github-cli.service.ts` (whose line count is frozen by
 * `scripts/file-length-baseline.json`) rather than added to it. `gh pr review`
 * only supports a flat body, not inline comments, so this goes through
 * `gh api` against the REST reviews/comments endpoints instead, which accept
 * `owner/repo` + PR number directly and support line-based (not legacy
 * diff-position-based) inline comments.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import { createLogger } from '@/backend/services/logger.service';
import { GH_CONCURRENCY, GH_TIMEOUT_MS } from './constants';

const execFileAsync = promisify(execFile);
const logger = createLogger('github-cli-code-review');

// A separate, small concurrency gate rather than sharing the main service's
// limiter: this path is a rare, user-triggered action (one click), not a poll
// loop, so it doesn't need to compete with or throttle high-frequency reads.
const execLimit = pLimit(GH_CONCURRENCY);

export type CodeReviewCommentSide = 'LEFT' | 'RIGHT';

export interface CodeReviewComment {
  path: string;
  line: number;
  side: CodeReviewCommentSide;
  body: string;
}

export interface SubmitCodeReviewInput {
  body: string;
  comments: CodeReviewComment[];
}

async function withTempJsonFile<T>(payload: unknown, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ff-gh-review-'));
  const filePath = join(dir, `${randomUUID()}.json`);
  try {
    await writeFile(filePath, JSON.stringify(payload));
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup; a leaked temp file is not worth failing the call over.
    });
  }
}

/**
 * Submit one review (summary + inline comments) via `gh api`, always as a
 * non-blocking `COMMENT`-event review — never `APPROVE`/`REQUEST_CHANGES`,
 * both of which GitHub rejects for a PR's own author, which this app's single
 * `gh` identity always is.
 */
export async function submitCodeReview(
  repo: string,
  prNumber: number,
  input: SubmitCodeReviewInput
): Promise<void> {
  const payload = {
    body: input.body,
    event: 'COMMENT',
    comments: input.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  };

  try {
    await withTempJsonFile(payload, (filePath) =>
      execLimit(() =>
        execFileAsync(
          'gh',
          [
            'api',
            '--method',
            'POST',
            `repos/${repo}/pulls/${prNumber}/reviews`,
            '--input',
            filePath,
          ],
          { timeout: GH_TIMEOUT_MS.default }
        )
      )
    );
    logger.info('Adversarial code review submitted', {
      repo,
      prNumber,
      commentCount: input.comments.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to submit code review via gh api', { repo, prNumber, error: errorMessage });
    throw new Error(`Failed to submit code review: ${errorMessage}`);
  }
}

/** The PR's own description body, not fetched by `getPRFullDetails`. */
export async function getPRDescription(repo: string, prNumber: number): Promise<string> {
  try {
    const { stdout } = await execLimit(() =>
      execFileAsync(
        'gh',
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body', '--jq', '.body'],
        { timeout: GH_TIMEOUT_MS.default }
      )
    );
    return stdout.trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to fetch PR description', { repo, prNumber, error: errorMessage });
    return '';
  }
}

/** The PR's current head commit SHA, needed to anchor a standalone review comment. */
export async function getPRHeadCommitSha(repo: string, prNumber: number): Promise<string> {
  try {
    const { stdout } = await execLimit(() =>
      execFileAsync(
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--repo',
          repo,
          '--json',
          'headRefOid',
          '--jq',
          '.headRefOid',
        ],
        { timeout: GH_TIMEOUT_MS.default }
      )
    );
    const sha = stdout.trim();
    if (!sha) {
      throw new Error('gh returned an empty head commit SHA');
    }
    return sha;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to fetch PR head commit SHA', { repo, prNumber, error: errorMessage });
    throw new Error(`Failed to fetch PR head commit SHA: ${errorMessage}`);
  }
}

/**
 * Post a single standalone inline comment (not part of a review object).
 *
 * Fallback path for when `submitCodeReview` is rejected because this app's
 * `gh` identity is also the PR's author: GitHub's REST "create a review
 * comment" endpoint has no such self-review restriction, since it carries no
 * approval semantics at all.
 */
export async function createReviewComment(
  repo: string,
  prNumber: number,
  input: { commitId: string; path: string; line: number; side: CodeReviewCommentSide; body: string }
): Promise<void> {
  const payload = {
    commit_id: input.commitId,
    path: input.path,
    line: input.line,
    side: input.side,
    body: input.body,
  };

  try {
    await withTempJsonFile(payload, (filePath) =>
      execLimit(() =>
        execFileAsync(
          'gh',
          [
            'api',
            '--method',
            'POST',
            `repos/${repo}/pulls/${prNumber}/comments`,
            '--input',
            filePath,
          ],
          { timeout: GH_TIMEOUT_MS.default }
        )
      )
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to create standalone review comment via gh api', {
      repo,
      prNumber,
      path: input.path,
      line: input.line,
      error: errorMessage,
    });
    throw new Error(`Failed to create review comment: ${errorMessage}`);
  }
}
