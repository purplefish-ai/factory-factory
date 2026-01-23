import { z } from 'zod';
import { decisionLogAccessor } from '../resource_accessors/decision-log.accessor';
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
    .query(async ({ input }) => {
      return decisionLogAccessor.findByAgentId(input.agentId, input.limit ?? 50);
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
    .query(async ({ input }) => {
      return decisionLogAccessor.findRecent(input?.limit ?? 100);
    }),

  // Get decision log by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const log = await decisionLogAccessor.findById(input.id);
    if (!log) {
      throw new Error(`Decision log not found: ${input.id}`);
    }
    return log;
  }),
});
