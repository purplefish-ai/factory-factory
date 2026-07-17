import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { ApplicationServices } from '@/backend/app-context';
import {
  autoIterationConfigSchema,
  autoIterationProgressSchema,
} from '@/shared/schemas/auto-iteration.schema';
import { publicProcedure, router } from './trpc';

function parseAutoIterationConfig(value: unknown) {
  const parsed = autoIterationConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid auto-iteration config: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

function parseAutoIterationProgress(value: unknown) {
  const parsed = autoIterationProgressSchema.safeParse(value);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid auto-iteration progress: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

/** Handle resume-from-failed: validate config/progress and delegate to service. */
async function handleResumeFromFailed(
  autoIterationService: ApplicationServices['autoIterationService'],
  workspace: { autoIterationConfig: unknown; autoIterationProgress: unknown },
  workspaceId: string
): Promise<void> {
  if (!workspace.autoIterationConfig) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Workspace has no auto-iteration config',
    });
  }
  const config = parseAutoIterationConfig(workspace.autoIterationConfig);
  if (!workspace.autoIterationProgress) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No progress data to resume from — use restart instead',
    });
  }
  const progress = parseAutoIterationProgress(workspace.autoIterationProgress);
  try {
    await autoIterationService.resumeFromFailed(workspaceId, config, progress);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already running')) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message });
    }
    throw err;
  }
}

export const autoIterationRouter = router({
  /** Start the auto-iteration loop for a workspace. */
  start: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { autoIterationService, workspaceDataService } = ctx.appContext.services;
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

      const config = parseAutoIterationConfig(workspace.autoIterationConfig);
      try {
        await autoIterationService.start(input.workspaceId, config);
      } catch (err) {
        if (err instanceof Error && err.message.includes('already running')) {
          throw new TRPCError({ code: 'CONFLICT', message: err.message });
        }
        throw err;
      }

      return { success: true };
    }),

  /** Pause the auto-iteration loop. */
  pause: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { autoIterationService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      autoIterationService.pause(input.workspaceId);
      return { success: true };
    }),

  /** Resume a paused or failed auto-iteration loop. */
  resume: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { autoIterationService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      if (
        workspace.autoIterationStatus !== 'PAUSED' &&
        workspace.autoIterationStatus !== 'FAILED'
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Auto-iteration can only be resumed from paused or failed state',
        });
      }

      if (workspace.autoIterationStatus === 'FAILED') {
        await handleResumeFromFailed(autoIterationService, workspace, input.workspaceId);
        return { success: true };
      }

      try {
        await autoIterationService.resume(input.workspaceId);
      } catch (err) {
        // Only map known user-state errors to BAD_REQUEST; rethrow unexpected failures
        if (
          err instanceof Error &&
          (err.message.includes('No auto-iteration loop found') ||
            err.message.includes('failed and was cleaned up'))
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: err.message,
          });
        }
        throw err;
      }
      return { success: true };
    }),

  /** Stop the auto-iteration loop. */
  stop: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { autoIterationService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      autoIterationService.stop(input.workspaceId);
      return { success: true };
    }),

  /** Get auto-iteration status snapshot. */
  getStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { autoIterationService, workspaceDataService } = ctx.appContext.services;
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
        config: workspace.autoIterationConfig
          ? parseAutoIterationConfig(workspace.autoIterationConfig)
          : null,
        progress: workspace.autoIterationProgress
          ? parseAutoIterationProgress(workspace.autoIterationProgress)
          : null,
      };
    }),

  /** Get the agent logbook for a workspace. */
  getLogbook: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { logbookService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      if (!workspace.worktreePath) {
        return null;
      }
      return logbookService.read(workspace.worktreePath);
    }),

  /** Get the insights file contents for a workspace. */
  getInsights: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { insightsService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      if (!workspace.worktreePath) {
        return null;
      }
      return insightsService.read(workspace.worktreePath);
    }),

  /** Save the insights file contents for a workspace. */
  saveInsights: publicProcedure
    .input(z.object({ workspaceId: z.string(), content: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { insightsService, workspaceDataService } = ctx.appContext.services;
      const workspace = await workspaceDataService.findById(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found' });
      }
      if (!workspace.worktreePath) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Workspace has no worktree path' });
      }
      await insightsService.write(workspace.worktreePath, input.content);
      return { success: true };
    }),
});
