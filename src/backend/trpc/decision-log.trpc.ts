import { z } from 'zod';
import { publicProcedure, router } from './trpc';

export const decisionLogRouter = router({
  // List decision logs by agent
  listByAgent: publicProcedure
    .input(
      z.object({
        agentId: z.string(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(({ ctx, input }) => {
      return ctx.appContext.services.decisionLogQueryService.findByAgentId(
        input.agentId,
        input.limit ?? 50
      );
    }),

  // List recent decision logs across all agents
  listRecent: publicProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(({ ctx, input }) => {
      return ctx.appContext.services.decisionLogQueryService.findRecent(input?.limit ?? 100);
    }),

  // Get decision log by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const log = await ctx.appContext.services.decisionLogQueryService.findById(input.id);
    if (!log) {
      throw new Error(`Decision log not found: ${input.id}`);
    }
    return log;
  }),
});
