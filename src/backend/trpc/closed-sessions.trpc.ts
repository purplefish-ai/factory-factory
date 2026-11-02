import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { closedSessionTranscriptSchema } from '@/shared/schemas/closed-session-transcript.schema';
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

      return closedSessions.map(
        ({
          archiveKey: _archiveKey,
          archiveState: _archiveState,
          transcriptHash: _transcriptHash,
          ...summary
        }) => summary
      );
    }),

  /**
   * Get a specific closed session with its full transcript
   */
  getTranscript: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { sessionDataService } = ctx.appContext.services;
      const closedSession = await sessionDataService.findClosedSessionByIdWithWorkspace(input.id);

      if (!closedSession) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Closed session not found: ${input.id}`,
        });
      }

      if (!(closedSession.archiveKey || closedSession.workspace.worktreePath)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Workspace has no worktree path',
        });
      }

      try {
        const transcriptPath = sessionDataService.resolveClosedSessionTranscriptPath(
          closedSession,
          closedSession.workspace.worktreePath
        );
        const content = await sessionDataService.readClosedSessionTranscript(
          closedSession,
          transcriptPath
        );
        const transcript = closedSessionTranscriptSchema.parse(JSON.parse(content));

        return {
          ...transcript,
          messages: transcript.messages.map(
            ({ providerPrompt: _providerPrompt, ...message }) => message
          ),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Transcript file not found',
          });
        }

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read transcript file',
        });
      }
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

    return { success: true };
  }),
});
