import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { workspaceDataService } from '@/backend/domains/workspace';
import { runScriptConfigPersistenceService } from '@/backend/services/run-script-config-persistence.service';
import { publicProcedure, router } from '@/backend/trpc/trpc';
import { FactoryConfigSchema } from '@/shared/schemas/factory-config.schema';

export const workspaceRunScriptRouter = router({
  // Create factory-factory.json configuration file
  createFactoryConfig: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        config: FactoryConfigSchema,
      })
    )
    .mutation(async ({ input }) => {
      const workspace = await workspaceDataService.findByIdWithProject(input.workspaceId);

      if (!workspace) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Workspace not found',
        });
      }

      if (!workspace.worktreePath) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Workspace worktree not initialized',
        });
      }

      try {
        await runScriptConfigPersistenceService.writeFactoryConfigAndSyncWorkspace({
          workspaceId: input.workspaceId,
          worktreePath: workspace.worktreePath,
          projectRepoPath: workspace.project?.repoPath,
          config: input.config,
          persistWorkspaceCommands: (id, commands) =>
            workspaceDataService.setRunScriptCommands(
              id,
              commands.runScriptCommand,
              commands.runScriptPostRunCommand,
              commands.runScriptCleanupCommand
            ),
        });

        return { success: true };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create factory-factory.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }),
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
        proxyUrl: result.proxyUrl ?? null,
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
