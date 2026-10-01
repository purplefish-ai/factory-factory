import { z } from 'zod';
import type { GitHubReview } from '@/shared/github-types';
import { GH_MAX_BUFFER_BYTES } from './constants';
import { mapReviews } from './mappers';
import { parseGhJson } from './utils';

const reviewPagesSchema = z.array(
  z.array(
    z.object({
      node_id: z.string(),
      user: z.object({ login: z.string() }).nullable(),
      state: z.string(),
      submitted_at: z.string().nullish(),
      body: z.string().optional(),
    })
  )
);

/**
 * REST guarantees chronological review order; gh pr view's GraphQL connection
 * does not document that guarantee. Preserve the ordinal across pages so callers
 * can break second-resolution submission ties without sorting opaque node IDs.
 * https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
 */
export async function getChronologicalReviews(
  repo: string,
  prNumber: number,
  read: (args: string[], options: { maxBuffer: number }) => Promise<{ stdout: string }>
): Promise<GitHubReview[]> {
  const { stdout } = await read(
    ['api', `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`, '--paginate', '--slurp'],
    { maxBuffer: GH_MAX_BUFFER_BYTES.reviews }
  );
  const reviews = parseGhJson(reviewPagesSchema, stdout, 'getChronologicalReviews').flat();
  return reviews.flatMap((review, chronologicalOrder) => {
    // A deleted reviewer cannot be matched safely to any approval.
    if (review.user === null) {
      return [];
    }
    const [mapped] = mapReviews([
      {
        id: review.node_id,
        author: review.user,
        state: review.state,
        submittedAt: review.submitted_at ?? null,
        body: review.body,
      },
    ]);
    return mapped ? [{ ...mapped, chronologicalOrder }] : [];
  });
}
