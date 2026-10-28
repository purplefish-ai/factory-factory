import { createLogger } from '@/backend/services/logger.service';
import type { PRWithFullDetails } from '@/shared/github-types';
import { GH_MAX_BUFFER_BYTES, GH_TIMEOUT_MS } from './constants';
import { classifyError } from './errors';
import { mapComments, mapLabels, mapStatusChecks } from './mappers';
import { getChronologicalReviews } from './reviews';
import { fullPRDetailsSchema, prReviewDetailsSchema, prStatusDetailsSchema } from './schemas';
import type { PRReviewDetails, PRStatusDetails } from './types';
import { parseGhJson } from './utils';

const logger = createLogger('github-cli');
type PRMetadataRead = (
  args: string[],
  options: { timeout?: number; maxBuffer?: number; signal?: AbortSignal }
) => Promise<{ stdout: string }>;

/** Core monitoring facts do not fetch review bodies or conversation comments. */
export async function getPRStatusDetails(
  repo: string,
  prNumber: number,
  read: PRMetadataRead,
  signal?: AbortSignal
): Promise<PRStatusDetails> {
  const fields = Object.keys(prStatusDetailsSchema.shape).join(',');
  const { stdout } = await read(
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', fields],
    { timeout: GH_TIMEOUT_MS.default, maxBuffer: GH_MAX_BUFFER_BYTES.fullPRDetails, signal }
  );
  signal?.throwIfAborted();
  const data = parseGhJson(prStatusDetailsSchema, stdout, 'getPRStatusDetails');
  return {
    ...data,
    statusCheckRollup: data.statusCheckRollup ? mapStatusChecks(data.statusCheckRollup) : null,
    headRefName: data.headRefName || '',
    baseRefName: data.baseRefName || '',
    mergeStateStatus: data.mergeStateStatus || 'UNKNOWN',
  };
}

/** Optional review metadata uses the same shared gh budget as core reads. */
export async function getPRReviewDetails(
  repo: string,
  prNumber: number,
  read: PRMetadataRead,
  signal?: AbortSignal
): Promise<PRReviewDetails> {
  const [{ stdout }, reviews] = await Promise.all([
    read(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'updatedAt,comments'], {
      timeout: GH_TIMEOUT_MS.default,
      maxBuffer: GH_MAX_BUFFER_BYTES.fullPRDetails,
      signal,
    }),
    getChronologicalReviews(repo, prNumber, (args, options) =>
      read(args, { ...options, timeout: GH_TIMEOUT_MS.default, signal })
    ),
  ]);
  signal?.throwIfAborted();
  const data = parseGhJson(prReviewDetailsSchema, stdout, 'getPRReviewDetails');
  return { updatedAt: data.updatedAt, comments: mapComments(data.comments), reviews };
}

/**
 * Get full PR details including reviews, comments, labels, and CI status.
 */
export async function getPRFullDetails(
  repo: string,
  prNumber: number,
  read: PRMetadataRead,
  signal?: AbortSignal
): Promise<PRWithFullDetails> {
  const fields = [
    'number',
    'title',
    'url',
    'author',
    'createdAt',
    'updatedAt',
    'isDraft',
    'state',
    'reviewDecision',
    'statusCheckRollup',
    'comments',
    'labels',
    'additions',
    'deletions',
    'changedFiles',
    'headRefName',
    'headRefOid',
    'baseRefName',
    'mergeStateStatus',
  ].join(',');

  try {
    const { stdout } = await read(
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', fields],
      { timeout: GH_TIMEOUT_MS.default, maxBuffer: GH_MAX_BUFFER_BYTES.fullPRDetails, signal }
    );

    const data = parseGhJson(fullPRDetailsSchema, stdout, 'getPRFullDetails');
    const reviews = await getChronologicalReviews(repo, prNumber, (args, options) =>
      read(args, { ...options, timeout: GH_TIMEOUT_MS.default, signal })
    );

    return {
      number: data.number,
      title: data.title,
      url: data.url,
      author: data.author,
      repository: {
        name: repo.split('/')[1] ?? '',
        nameWithOwner: repo,
      },
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      isDraft: data.isDraft,
      state: data.state,
      reviewDecision: data.reviewDecision,
      statusCheckRollup: data.statusCheckRollup ? mapStatusChecks(data.statusCheckRollup) : null,
      reviews,
      comments: mapComments(data.comments),
      labels: mapLabels(data.labels),
      additions: data.additions || 0,
      deletions: data.deletions || 0,
      changedFiles: data.changedFiles || 0,
      headRefOid: data.headRefOid,
      headRefName: data.headRefName || '',
      baseRefName: data.baseRefName || '',
      mergeStateStatus: data.mergeStateStatus || 'UNKNOWN',
    };
  } catch (error) {
    signal?.throwIfAborted();
    const errorType = classifyError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to fetch PR details via gh CLI', {
      repo,
      prNumber,
      errorType,
      error: errorMessage,
    });

    throw new Error(`Failed to fetch PR details: ${errorMessage}`);
  }
}

export async function getPRDiff(
  repo: string,
  prNumber: number,
  read: PRMetadataRead
): Promise<string> {
  try {
    const { stdout } = await read(['pr', 'diff', String(prNumber), '--repo', repo], {
      timeout: GH_TIMEOUT_MS.diff,
      maxBuffer: GH_MAX_BUFFER_BYTES.diff,
    });

    return stdout;
  } catch (error) {
    const errorType = classifyError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Failed to fetch PR diff via gh CLI', {
      repo,
      prNumber,
      errorType,
      error: errorMessage,
    });

    throw new Error(`Failed to fetch PR diff: ${errorMessage}`);
  }
}
