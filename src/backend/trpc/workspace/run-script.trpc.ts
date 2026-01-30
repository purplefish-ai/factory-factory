import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { RunScriptService } from '../../services/run-script.service';
import { publicProcedure, router } from '../trpc';

export const workspaceRunScriptRouter = router({
  // Start the run script for a workspace
  startRunScript: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const result = await RunScriptService.startRunScript(input.workspaceId);

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
    .mutation(async ({ input }) => {
      const result = await RunScriptService.stopRunScript(input.workspaceId);

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
    // biome-ignore lint/suspicious/useAwait: Service method is async
    .query(async ({ input }) => {
      return RunScriptService.getRunScriptStatus(input.workspaceId);
    }),
});
