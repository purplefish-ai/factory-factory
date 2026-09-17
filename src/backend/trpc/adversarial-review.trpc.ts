/**
 * Adversarial Review tRPC Router
 *
 * Triggers an on-demand review of a workspace's open PR using the
 * Admin-configured reviewer provider/model. See
 * docs/design/adversarial-review.md.
 */

import { z } from 'zod';
import { router, trustedLocalProcedure } from './trpc';

export const adversarialReviewRouter = router({
  trigger: trustedLocalProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return await ctx.appContext.services.triggerAdversarialReview(input.workspaceId);
    }),
});
