import { SessionStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { SessionManager } from '../claude/session';
import { getQuickAction, listQuickActions } from '../prompts/quick-actions';
import { sessionDataService } from '../services/session-data.service';
import { workspaceDataService } from '../services/workspace-data.service';
import { publicProcedure, router } from './trpc';

export const sessionRouter = router({
  // Session limits

  // Get the maximum number of sessions allowed per workspace
  getMaxSessionsPerWorkspace: publicProcedure.query(({ ctx }) => {
    return ctx.appContext.services.configService.getMaxSessionsPerWorkspace();
  }),

  // Quick Actions

  // List all available quick actions
  listQuickActions: publicProcedure.query(() => listQuickActions()),

  // Get a specific quick action by ID
  getQuickAction: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => getQuickAction(input.id)),

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
    .query(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      const { workspaceId, ...filters } = input;
      const sessions = await sessionDataService.findClaudeSessionsByWorkspaceId(
        workspaceId,
        filters
      );
      // Augment sessions with real-time working status from in-memory process state
      return sessions.map((session) => ({
        ...session,
        isWorking: sessionService.isSessionWorking(session.id),
      }));
    }),

  // Get claude session by ID
  getClaudeSession: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const session = await sessionDataService.findClaudeSessionById(input.id);
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
    .mutation(async ({ ctx, input }) => {
      const { configService } = ctx.appContext.services;
      // Check per-workspace session limit
      const maxSessions = configService.getMaxSessionsPerWorkspace();
      const existingSessions = await sessionDataService.findClaudeSessionsByWorkspaceId(
        input.workspaceId
      );

      if (existingSessions.length >= maxSessions) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Maximum sessions per workspace (${maxSessions}) reached`,
        });
      }

      const workspace = await workspaceDataService.findById(input.workspaceId);
      const claudeProjectPath = workspace?.worktreePath
        ? SessionManager.getProjectPath(workspace.worktreePath)
        : null;
      const session = await sessionDataService.createClaudeSession({
        ...input,
        claudeProjectPath,
      });
      return session;
    }),

  // Update a claude session (metadata only - use start/stop for status changes)
  updateClaudeSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        workflow: z.string().optional(),
        model: z.string().optional(),
        claudeSessionId: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return sessionDataService.updateClaudeSession(id, updates);
    }),

  // Start a claude session (spawns the Claude process)
  startClaudeSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        initialPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      await sessionService.startClaudeSession(input.id, {
        initialPrompt: input.initialPrompt,
      });
      return sessionDataService.findClaudeSessionById(input.id);
    }),

  // Stop a claude session (gracefully stops the process)
  stopClaudeSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      await sessionService.stopClaudeSession(input.id);
      return sessionDataService.findClaudeSessionById(input.id);
    }),

  // Delete a claude session
  deleteClaudeSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionService, sessionDomainService } = ctx.appContext.services;
      // Stop process first to prevent orphaned Claude processes
      await sessionService.stopClaudeSession(input.id, {
        cleanupTransientRatchetSession: false,
      });
      // Clear any in-memory session store state
      sessionDomainService.clearSession(input.id);
      return sessionDataService.deleteClaudeSession(input.id);
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
      return sessionDataService.findTerminalSessionsByWorkspaceId(workspaceId, filters);
    }),

  // Get terminal session by ID
  getTerminalSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const session = await sessionDataService.findTerminalSessionById(input.id);
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
      return sessionDataService.createTerminalSession(input);
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
      return sessionDataService.updateTerminalSession(id, updates);
    }),

  // Delete a terminal session
  deleteTerminalSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      return sessionDataService.deleteTerminalSession(input.id);
    }),
});
