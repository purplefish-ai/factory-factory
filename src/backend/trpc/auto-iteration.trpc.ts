import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  autoIterationService,
  insightsService,
  logbookService,
} from '@/backend/services/auto-iteration';
import { workspaceDataService } from '@/backend/services/workspace';
import { publicProcedure, router } from './trpc';

const autoIterationConfigSchema = z.object({
  testCommand: z.string().min(1),
  targetDescription: z.string().min(1),
  maxIterations: z.number().int().min(0).default(25),
  testTimeoutSeconds: z.number().int().min(1).default(600),
  sessionRecycleInterval: z.number().int().min(1).default(10),
});

/** Handle resume-from-failed: validate config/progress and delegate to service. */
async function handleResumeFromFailed(
  workspace: { autoIterationConfig: unknown; autoIterationProgress: unknown },
  workspaceId: string
): Promise<void> {
  if (!workspace.autoIterationConfig) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Workspace has no auto-iteration config',
    });
  }
  const configParsed = autoIterationConfigSchema.safeParse(workspace.autoIterationConfig);
  if (!configParsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Invalid auto-iteration config: ${configParsed.error.message}`,
    });
  }
  const progress = workspace.autoIterationProgress as Record<string, unknown> | null;
  if (!progress) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'No progress data to resume from — use restart instead',
    });
  }
  try {
    await autoIterationService.resumeFromFailed(
      workspaceId,
      configParsed.data,
      progress as unknown as Parameters<typeof autoIterationService.resumeFromFailed>[2]
    );
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

      const configParsed = autoIterationConfigSchema.safeParse(workspace.autoIterationConfig);
      if (!configParsed.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Invalid auto-iteration config: ${configParsed.error.message}`,
        });
      }
      try {
        await autoIterationService.start(input.workspaceId, configParsed.data);
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
    .mutation(async ({ input }) => {
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
    .mutation(async ({ input }) => {
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
        await handleResumeFromFailed(workspace, input.workspaceId);
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
  stop: publicProcedure.input(z.object({ workspaceId: z.string() })).mutation(async ({ input }) => {
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

  /** Get the insights file contents for a workspace. */
  getInsights: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
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
    .mutation(async ({ input }) => {
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
