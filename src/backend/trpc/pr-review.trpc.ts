/**
 * PR Review tRPC Router
 *
 * Provides operations for managing PR review requests via gh CLI.
 */

import { z } from 'zod';
import { githubPRPreviewInputSchema } from '@/shared/github-pr-preview';
import type { ReviewAction } from '@/shared/github-types';
import { publicProcedure, router } from './trpc';

export const prReviewRouter = router({
  /**
   * List all PRs where the authenticated user is requested as a reviewer.
   */
  listReviewRequests: publicProcedure
    .input(z.object({ projectId: z.string() }).optional())
    .query(async ({ ctx, input }) => {
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
        let repository: string | undefined;
        if (input) {
          const project = await ctx.appContext.services.projectManagementService.findById(
            input.projectId
          );
          if (!project) {
            throw new Error('Project not found');
          }
          if (!(project.githubOwner && project.githubRepo)) {
            throw new Error('Project is not linked to a GitHub repository');
          }
          repository = `${project.githubOwner}/${project.githubRepo}`;
          if (!githubPRPreviewInputSchema.shape.repo.safeParse(repository).success) {
            throw new Error('Invalid GitHub repository');
          }
        }
        const prs = await ctx.appContext.services.listVisibleReviewRequests(repository);
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
