import { createHash } from 'node:crypto';
import type { PRObservation } from '@/shared/pr-monitoring';
import type { RatchetReviewTriggerMode } from '@prisma-gen/client';
import type { githubCLIService } from './github-cli.service';
import {
  isIgnoredReviewAuthor,
  isOwnAdversarialReviewMarker,
  selectActionableReviews,
} from './pr-actionable-review';

interface ReviewFactsPorts {
  readPolicy(): Promise<{ reviewTriggerMode: RatchetReviewTriggerMode }>;
  readUsername(signal?: AbortSignal): Promise<string | null>;
  readDetails: typeof githubCLIService.getPRReviewDetails;
  readComments: typeof githubCLIService.getReviewComments;
  readResolvedIds: typeof githubCLIService.getResolvedReviewCommentIds;
}

type ReviewFacts = Pick<
  PRObservation,
  'actionableReviews' | 'reviewsComplete' | 'resolvedReviewIds'
>;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function timestamp(value: string | null | undefined): string | null {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A failed enrichment cannot claim that previously observed feedback resolved. */
export async function fetchPRReviewFacts(
  ports: ReviewFactsPorts,
  repository: string,
  number: number,
  url: string,
  signal?: AbortSignal
): Promise<ReviewFacts> {
  try {
    signal?.throwIfAborted();
    const [policy, username] = await Promise.all([ports.readPolicy(), ports.readUsername(signal)]);
    if (!username) {
      return { actionableReviews: [], reviewsComplete: false, resolvedReviewIds: [] };
    }
    let reviewsComplete = true;
    const incomplete = () => {
      reviewsComplete = false;
    };
    const [details, comments, resolved] = await Promise.all([
      ports.readDetails(repository, number, signal),
      ports.readComments(repository, number, undefined, signal, incomplete),
      ports.readResolvedIds(repository, number, signal, incomplete),
    ]);
    signal?.throwIfAborted();
    const actionableReviews = [
      ...selectActionableReviews(details.reviews, username, policy.reviewTriggerMode).map((r) => ({
        identity: `review:${r.id}`,
        contentHash: hash(r.body ?? ''),
        author: r.author.login,
        body: r.body ?? '',
        path: null,
        line: null,
        url: `${url}#pullrequestreview-${r.id}`,
        activityAt:
          timestamp(r.submittedAt) ?? timestamp(details.updatedAt) ?? '1970-01-01T00:00:00.000Z',
      })),
      ...comments
        .filter((c) => !(resolved.has(c.id) || isIgnoredReviewAuthor(c.author.login, username)))
        .map((c) => ({
          identity: `comment:${c.id}`,
          contentHash: hash(c.body),
          author: c.author.login,
          body: c.body,
          path: c.path,
          line: c.line,
          url: c.url,
          activityAt:
            timestamp(c.updatedAt) ?? timestamp(c.createdAt) ?? '1970-01-01T00:00:00.000Z',
        })),
      ...details.comments
        .filter((c) => isOwnAdversarialReviewMarker(c, username))
        .map((c) => ({
          identity: `conversation:${c.id}`,
          contentHash: hash(c.body),
          author: c.author.login,
          body: c.body,
          path: null,
          line: null,
          url: c.url,
          activityAt:
            timestamp(c.updatedAt) ?? timestamp(c.createdAt) ?? '1970-01-01T00:00:00.000Z',
        })),
    ];
    return {
      actionableReviews,
      reviewsComplete,
      resolvedReviewIds: [...resolved].map((id) => `comment:${id}`),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    return { actionableReviews: [], reviewsComplete: false, resolvedReviewIds: [] };
  }
}
