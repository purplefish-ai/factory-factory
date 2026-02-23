import { SessionProvider } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { sessionDataService, sessionProviderResolverService } from '@/backend/domains/session';
import { getProviderUnavailableMessage } from '@/backend/lib/provider-cli-availability';
import { getQuickAction, listQuickActions } from '@/backend/prompts/quick-actions';
import { SessionStatus } from '@/shared/core';
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

  // Sessions

  // List sessions for a workspace
  listSessions: publicProcedure
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
      const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(
        workspaceId,
        filters
      );
      // Augment sessions with real-time working status from in-memory process state
      return sessions.map((session) => ({
        ...session,
        isWorking: sessionService.isSessionWorking(session.id),
      }));
    }),

  // Get session by ID
  getSession: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const session = await sessionDataService.findAgentSessionById(input.id);
    if (!session) {
      throw new Error(`Session not found: ${input.id}`);
    }
    return session;
  }),

  // Create a new session
  createSession: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        name: z.string().optional(),
        workflow: z.string(),
        model: z.string().optional(),
        provider: z.nativeEnum(SessionProvider).optional(),
        initialMessage: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { configService, sessionDomainService } = ctx.appContext.services;
      // Check per-workspace session limit
      const maxSessions = configService.getMaxSessionsPerWorkspace();
      const existingSessions = await sessionDataService.findAgentSessionsByWorkspaceId(
        input.workspaceId
      );

      if (existingSessions.length >= maxSessions) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Maximum sessions per workspace (${maxSessions}) reached`,
        });
      }

      const provider = await sessionProviderResolverService.resolveSessionProvider({
        workspaceId: input.workspaceId,
        explicitProvider: input.provider,
      });

      const cliHealth = await ctx.appContext.services.cliHealthService.checkHealth();
      const providerUnavailableMessage = getProviderUnavailableMessage(provider, cliHealth);
      if (providerUnavailableMessage) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: providerUnavailableMessage,
        });
      }

      const session = await sessionDataService.createAgentSession({
        workspaceId: input.workspaceId,
        name: input.name,
        workflow: input.workflow,
        model: input.model,
        provider,
      });
      if (input.initialMessage) {
        sessionDomainService.storeInitialMessage(session.id, input.initialMessage);
      }
      return session;
    }),

  // Update a session (metadata only - use start/stop for status changes)
  updateSession: publicProcedure
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
      return sessionDataService.updateAgentSession(id, updates);
    }),

  // Start a session
  startSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        initialPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      await sessionService.startSession(input.id, {
        initialPrompt: input.initialPrompt,
      });
      return sessionDataService.findAgentSessionById(input.id);
    }),

  // Stop a session
  stopSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      await sessionService.stopSession(input.id, {
        cleanupTransientRatchetSession: false,
      });
      return sessionDataService.findAgentSessionById(input.id);
    }),

  // Delete a session
  deleteSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionService, sessionDomainService } = ctx.appContext.services;
      // Stop process first to prevent orphaned session processes
      await sessionService.stopSession(input.id, {
        cleanupTransientRatchetSession: false,
      });
      // Clear any in-memory session store state
      sessionDomainService.clearSession(input.id);
      return sessionDataService.deleteAgentSession(input.id);
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
