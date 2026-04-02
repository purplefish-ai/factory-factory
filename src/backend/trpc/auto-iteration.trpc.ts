import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { autoIterationService, logbookService } from '@/backend/services/auto-iteration';
import { workspaceDataService } from '@/backend/services/workspace';
import { publicProcedure, router } from './trpc';

export const autoIterationRouter = router({
  /** Start the auto-iteration loop for a workspace. */
  start: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      if (workspace.mode !== 'AUTO_ITERATION') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Workspace is not an auto-iteration workspace',
        });
      }
      if (!workspace.autoIterationConfig) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Workspace has no auto-iteration config',
        });
      }
      if (autoIterationService.isRunning(input.workspaceId)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Auto-iteration is already running',
        });
      }

      const config = workspace.autoIterationConfig as Record<string, unknown>;
      await autoIterationService.start(input.workspaceId, {
        testCommand: config.testCommand as string,
        targetDescription: config.targetDescription as string,
        maxIterations: (config.maxIterations as number) ?? 25,
        testTimeoutSeconds: (config.testTimeoutSeconds as number) ?? 300,
        sessionRecycleInterval: (config.sessionRecycleInterval as number) ?? 10,
      });

      return { success: true };
    }),

  /** Pause the auto-iteration loop. */
  pause: publicProcedure.input(z.object({ workspaceId: z.string() })).mutation(({ input }) => {
    autoIterationService.pause(input.workspaceId);
    return { success: true };
  }),

  /** Resume a paused auto-iteration loop. */
  resume: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      await autoIterationService.resume(input.workspaceId);
      return { success: true };
    }),

  /** Stop the auto-iteration loop. */
  stop: publicProcedure.input(z.object({ workspaceId: z.string() })).mutation(({ input }) => {
    autoIterationService.stop(input.workspaceId);
    return { success: true };
  }),

  /** Get auto-iteration status snapshot. */
  getStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      // Check in-memory state first
      const running = autoIterationService.getStatus(input.workspaceId);
      if (running) {
        return running;
      }

      // Fall back to DB state (for stopped/completed loops)
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      return {
        status: workspace.autoIterationStatus ?? null,
        config: workspace.autoIterationConfig ?? null,
        progress: workspace.autoIterationProgress ?? null,
      };
    }),

  /** Get the agent logbook for a workspace. */
  getLogbook: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      if (!workspace.worktreePath) {
        return null;
      }
      return logbookService.read(workspace.worktreePath);
    }),
});
