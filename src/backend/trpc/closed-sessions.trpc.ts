import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router } from './trpc';

export const closedSessionsRouter = router({
  /**
   * List closed sessions for a workspace, ordered by most recent first
   */
  list: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        limit: z.number().min(1).max(50).default(20).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { sessionDataService } = ctx.appContext.services;
      const { workspaceId, limit = 20 } = input;

      const closedSessions = await sessionDataService.findClosedSessionsByWorkspaceId(
        workspaceId,
        limit
      );

      return closedSessions;
    }),

  /**
   * Get a specific closed session with its full transcript
   */
  getTranscript: publicProcedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => {
    const { sessionDataService } = ctx.appContext.services;
    return sessionDataService.readClosedSessionTranscript(input.id);
  }),

  // JSON text preserves reserved keys through the shared SuperJSON transformer.
  getTranscriptJson: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { sessionDataService } = ctx.appContext.services;
      return JSON.stringify(await sessionDataService.readClosedSessionTranscript(input.id));
    }),

  /**
   * Delete a closed session and its transcript file
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const { sessionDataService } = ctx.appContext.services;
    const closedSession = await sessionDataService.findClosedSessionByIdWithWorkspace(input.id);

    if (!closedSession) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Closed session not found: ${input.id}`,
      });
    }

    // Delete from database first
    await sessionDataService.deleteClosedSession(input.id);

    // Best-effort delete transcript file (don't throw if it fails)
    if (closedSession.workspace.worktreePath) {
      try {
        const transcriptPath = join(
          closedSession.workspace.worktreePath,
          closedSession.transcriptPath
        );
        await unlink(transcriptPath);
      } catch {
        // Ignore file deletion errors
      }
    }

    return { success: true };
  }),
});
