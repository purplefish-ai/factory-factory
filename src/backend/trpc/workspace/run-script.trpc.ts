import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router } from '@/backend/trpc/trpc';

export const workspaceRunScriptRouter = router({
  // Start the run script for a workspace
  startRunScript: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.appContext.services.runScriptService.startRunScript(
        input.workspaceId
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error ?? 'Failed to start run script',
        });
      }

      return {
        success: true,
        port: result.port,
        pid: result.pid,
      };
    }),

  // Stop the run script for a workspace
  stopRunScript: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.appContext.services.runScriptService.stopRunScript(
        input.workspaceId
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error ?? 'Failed to stop run script',
        });
      }

      return { success: true };
    }),

  // Get run script status for a workspace
  getRunScriptStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.appContext.services.runScriptService.getRunScriptStatus(input.workspaceId)
    ),
});
