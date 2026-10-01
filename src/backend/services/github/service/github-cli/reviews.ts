import { z } from 'zod';
import type { GitHubReview } from '@/shared/github-types';
import { GH_MAX_BUFFER_BYTES } from './constants';
import { mapReviews } from './mappers';
import { reviewItemSchema } from './schemas';
import { parseGhJson } from './utils';

const reviewPagesSchema = z.array(
  z.array(
    z.object({
      node_id: reviewItemSchema.shape.id,
      user: reviewItemSchema.shape.author.omit({ isUnknown: true }).nullable(),
      state: reviewItemSchema.shape.state,
      submitted_at: reviewItemSchema.shape.submittedAt.optional(),
      body: reviewItemSchema.shape.body,
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
  return mapReviews(
    reviews.map((review) => ({
      id: review.node_id,
      // Unknown authors retain feedback but cannot be matched to an approval.
      author: review.user ?? { login: '(deleted reviewer)', isUnknown: true },
      state: review.state,
      submittedAt: review.submitted_at ?? null,
      body: review.body,
    }))
  ).map((review, chronologicalOrder) => ({ ...review, chronologicalOrder }));
}
