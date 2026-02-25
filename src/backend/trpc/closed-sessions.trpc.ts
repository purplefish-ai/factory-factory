import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@/backend/db';
import type { ClosedSessionTranscript } from '@/backend/domains/session/lifecycle/closed-session-persistence.service';
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
    .query(async ({ input }) => {
      const { workspaceId, limit = 20 } = input;

      const closedSessions = await prisma.closedSession.findMany({
        where: { workspaceId },
        orderBy: { completedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          sessionId: true,
          name: true,
          workflow: true,
          provider: true,
          model: true,
          startedAt: true,
          completedAt: true,
          // Don't include transcriptPath in list view for performance
        },
      });

      return closedSessions;
    }),

  /**
   * Get a specific closed session with its full transcript
   */
  getTranscript: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const closedSession = await prisma.closedSession.findUnique({
      where: { id: input.id },
      include: {
        workspace: {
          select: {
            id: true,
            worktreePath: true,
          },
        },
      },
    });

    if (!closedSession) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Closed session not found: ${input.id}`,
      });
    }

    if (!closedSession.workspace.worktreePath) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Workspace has no worktree path',
      });
    }

    // Read transcript from file
    const transcriptPath = join(closedSession.workspace.worktreePath, closedSession.transcriptPath);

    try {
      const content = await readFile(transcriptPath, 'utf-8');
      const transcript: ClosedSessionTranscript = JSON.parse(content);

      return transcript;
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
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const closedSession = await prisma.closedSession.findUnique({
      where: { id: input.id },
      include: {
        workspace: {
          select: {
            worktreePath: true,
          },
        },
      },
    });

    if (!closedSession) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Closed session not found: ${input.id}`,
      });
    }

    // Delete from database first
    await prisma.closedSession.delete({
      where: { id: input.id },
    });

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
