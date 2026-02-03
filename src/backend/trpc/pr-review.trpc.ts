/**
 * PR Review tRPC Router
 *
 * Provides operations for managing PR review requests via gh CLI.
 */

import { z } from 'zod';
import type { ReviewAction } from '@/shared/github-types';
import { publicProcedure, router } from './trpc';

export const prReviewRouter = router({
  /**
   * List all PRs where the authenticated user is requested as a reviewer.
   */
  listReviewRequests: publicProcedure.query(async ({ ctx }) => {
    const { githubCLIService } = ctx.appContext.services;
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
    .mutation(async ({ ctx, input }) => {
      const { githubCLIService } = ctx.appContext.services;
      await githubCLIService.approvePR(input.owner, input.repo, input.prNumber);
      return { success: true };
    }),

  /**
   * Check gh CLI health status.
   */
  checkHealth: publicProcedure.query(({ ctx }) => {
    return ctx.appContext.services.githubCLIService.checkHealth();
  }),

  /**
   * Get full details for a PR including reviews, comments, and CI status.
   */
  getPRDetails: publicProcedure
    .input(
      z.object({
        repo: z.string(), // owner/repo format
        number: z.number(),
      })
    )
    .query(async ({ ctx, input }) => {
      return await ctx.appContext.services.githubCLIService.getPRFullDetails(
        input.repo,
        input.number
      );
    }),

  /**
   * Get the diff for a PR.
   */
  getDiff: publicProcedure
    .input(
      z.object({
        repo: z.string(),
        number: z.number(),
      })
    )
    .query(async ({ ctx, input }) => {
      const diff = await ctx.appContext.services.githubCLIService.getPRDiff(
        input.repo,
        input.number
      );
      return { diff };
    }),

  /**
   * Submit a review for a PR (approve, request changes, or comment).
   */
  submitReview: publicProcedure
    .input(
      z.object({
        repo: z.string(),
        number: z.number(),
        action: z.enum(['approve', 'request-changes', 'comment']),
        body: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.appContext.services.githubCLIService.submitReview(
        input.repo,
        input.number,
        input.action as ReviewAction,
        input.body
      );
      return { success: true };
    }),
});
