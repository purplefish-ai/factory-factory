import { SessionStatus } from '@prisma-gen/client';
import { z } from 'zod';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor.js';
import { terminalSessionAccessor } from '../resource_accessors/terminal-session.accessor.js';
import { sessionService } from '../services/session.service.js';
import { publicProcedure, router } from './trpc.js';

export const sessionRouter = router({
  // Claude Sessions

  // List claude sessions for a workspace
  listClaudeSessions: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        status: z.nativeEnum(SessionStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(({ input }) => {
      const { workspaceId, ...filters } = input;
      return claudeSessionAccessor.findByWorkspaceId(workspaceId, filters);
    }),

  // Get claude session by ID
  getClaudeSession: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const session = await claudeSessionAccessor.findById(input.id);
    if (!session) {
      throw new Error(`Claude session not found: ${input.id}`);
    }
    return session;
  }),

  // Create a new claude session
  createClaudeSession: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().optional(),
        workflow: z.string(),
        model: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      return claudeSessionAccessor.create(input);
    }),

  // Update a claude session (metadata only - use start/stop for status changes)
  updateClaudeSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        workflow: z.string().optional(),
        model: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return claudeSessionAccessor.update(id, updates);
    }),

  // Start a claude session (spawns the Claude process)
  startClaudeSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        initialPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      await sessionService.startClaudeSession(input.id, {
        initialPrompt: input.initialPrompt,
      });
      return claudeSessionAccessor.findById(input.id);
    }),

  // Stop a claude session (gracefully stops the process)
  stopClaudeSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await sessionService.stopClaudeSession(input.id);
      return claudeSessionAccessor.findById(input.id);
    }),

  // Delete a claude session
  deleteClaudeSession: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    return claudeSessionAccessor.delete(input.id);
  }),

  // Terminal Sessions

  // List terminal sessions for a workspace
  listTerminalSessions: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        status: z.nativeEnum(SessionStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(({ input }) => {
      const { workspaceId, ...filters } = input;
      return terminalSessionAccessor.findByWorkspaceId(workspaceId, filters);
    }),

  // Get terminal session by ID
  getTerminalSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const session = await terminalSessionAccessor.findById(input.id);
      if (!session) {
        throw new Error(`Terminal session not found: ${input.id}`);
      }
      return session;
    }),

  // Create a new terminal session
  createTerminalSession: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      return terminalSessionAccessor.create(input);
    }),

  // Update a terminal session
  updateTerminalSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        status: z.nativeEnum(SessionStatus).optional(),
        pid: z.number().optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return terminalSessionAccessor.update(id, updates);
    }),

  // Delete a terminal session
  deleteTerminalSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      return terminalSessionAccessor.delete(input.id);
    }),

  // Working Status

  // Check if any session in a workspace is actively working
  isWorkspaceWorking: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const sessions = await claudeSessionAccessor.findByWorkspaceId(input.workspaceId);
      const sessionIds = sessions.map((s) => s.id);
      return sessionService.isAnySessionWorking(sessionIds);
    }),

  // Get working status for multiple workspaces at once
  getWorkspacesWorkingStatus: publicProcedure
    .input(z.object({ workspaceIds: z.array(z.string()) }))
    .query(async ({ input }) => {
      const result: Record<string, boolean> = {};
      for (const workspaceId of input.workspaceIds) {
        const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId);
        const sessionIds = sessions.map((s) => s.id);
        result[workspaceId] = sessionService.isAnySessionWorking(sessionIds);
      }
      return result;
    }),
});
