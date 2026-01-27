/**
 * PR Review tRPC Router
 *
 * Provides operations for managing PR review requests via gh CLI.
 */

import { z } from 'zod';
import { githubCLIService } from '../services/github-cli.service';
import { publicProcedure, router } from './trpc';

export const prReviewRouter = router({
  /**
   * List all PRs where the authenticated user is requested as a reviewer.
   */
  listReviewRequests: publicProcedure.query(async () => {
    const health = await githubCLIService.checkHealth();

    if (!(health.isInstalled && health.isAuthenticated)) {
      return {
        prs: [],
        health,
        error: null,
      };
    }

    try {
      const prs = await githubCLIService.listReviewRequests();
      return {
        prs,
        health,
        error: null,
      };
    } catch (err) {
      return {
        prs: [],
        health,
        error: err instanceof Error ? err.message : 'Failed to fetch review requests',
      };
    }
  }),

  /**
   * Approve a PR.
   */
  approve: publicProcedure
    .input(
      z.object({
        owner: z.string(),
        repo: z.string(),
        prNumber: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      await githubCLIService.approvePR(input.owner, input.repo, input.prNumber);
      return { success: true };
    }),

  /**
   * Check gh CLI health status.
   */
  checkHealth: publicProcedure.query(() => {
    return githubCLIService.checkHealth();
  }),
});
