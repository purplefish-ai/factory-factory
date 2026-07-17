import { SessionProvider } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getProviderUnavailableMessage } from '@/backend/lib/provider-cli-availability';
import { SessionStatus } from '@/shared/core';
import { type Context, publicProcedure, router } from './trpc';

const createSessionInputSchema = z.object({
  workspaceId: z.string(),
  name: z.string().optional(),
  workflow: z.string(),
  model: z.string().optional(),
  provider: z.nativeEnum(SessionProvider).optional(),
  initialMessage: z.string().optional(),
});

async function createAgentSessionFromInput(
  ctx: Context,
  input: z.infer<typeof createSessionInputSchema>
) {
  const {
    configService,
    sessionDataService,
    sessionDomainService,
    sessionProviderResolverService,
  } = ctx.appContext.services;
  const maxSessions = configService.getMaxSessionsPerWorkspace();

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

  const creation = await sessionDataService.createAgentSessionWithinWorkspaceLimit({
    workspaceId: input.workspaceId,
    name: input.name,
    workflow: input.workflow,
    model: input.model,
    provider,
    maxSessions,
  });
  if (creation.outcome === 'limit_reached') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Maximum sessions per workspace (${maxSessions}) reached`,
    });
  }

  const session = creation.session;
  if (input.initialMessage) {
    sessionDomainService.storeInitialMessage(session.id, input.initialMessage);
  }
  return session;
}

async function rollbackCreatedSession(
  sessionId: string,
  sessionDataService: Context['appContext']['services']['sessionDataService'],
  sessionDomainService: Context['appContext']['services']['sessionDomainService']
) {
  sessionDomainService.clearSession(sessionId);

  try {
    await sessionDataService.deleteAgentSession(sessionId);
  } catch {
    try {
      await sessionDataService.updateAgentSession(sessionId, {
        status: SessionStatus.FAILED,
        providerProcessPid: null,
        providerMetadata: {
          rollbackReason: 'startup_failed_after_create',
        },
      });
    } catch {
      // Preserve the startup error even if rollback cleanup cannot repair the row.
    }
  }
}

export const sessionRouter = router({
  // Session limits

  // Get the maximum number of sessions allowed per workspace
  getMaxSessionsPerWorkspace: publicProcedure.query(({ ctx }) => {
    return ctx.appContext.services.configService.getMaxSessionsPerWorkspace();
  }),

  // Quick Actions

  // List all available quick actions
  listQuickActions: publicProcedure.query(({ ctx }) => ctx.appContext.services.listQuickActions()),

  // Get a specific quick action by ID
  getQuickAction: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => ctx.appContext.services.getQuickAction(input.id)),

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
      const { sessionDataService, sessionService } = ctx.appContext.services;
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
  getSession: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const { sessionDataService } = ctx.appContext.services;
    const session = await sessionDataService.findAgentSessionById(input.id);
    if (!session) {
      throw new Error(`Session not found: ${input.id}`);
    }
    return session;
  }),

  // Create a new session
  createSession: publicProcedure.input(createSessionInputSchema).mutation(({ ctx, input }) => {
    return createAgentSessionFromInput(ctx, input);
  }),

  // Create and start a session as one atomic user action.
  createAndStartSession: publicProcedure
    .input(
      createSessionInputSchema.extend({
        initialPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { sessionDataService, sessionService, sessionDomainService } = ctx.appContext.services;
      const session = await createAgentSessionFromInput(ctx, input);

      try {
        await sessionService.startSession(session.id, {
          initialPrompt: input.initialPrompt,
        });
      } catch (error) {
        try {
          await sessionService.stopSession(session.id, {
            cleanupTransientRatchetSession: false,
          });
        } catch {
          // Best-effort runtime cleanup; preserve the startup error.
        }

        await rollbackCreatedSession(session.id, sessionDataService, sessionDomainService);

        throw error;
      }

      return (await sessionDataService.findAgentSessionById(session.id)) ?? session;
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
    .mutation(({ ctx, input }) => {
      const { sessionDataService } = ctx.appContext.services;
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
      const { sessionDataService, sessionService } = ctx.appContext.services;
      await sessionService.startSession(input.id, {
        initialPrompt: input.initialPrompt,
      });
      return sessionDataService.findAgentSessionById(input.id);
    }),

  // Stop a session
  stopSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionDataService, sessionService } = ctx.appContext.services;
      await sessionService.stopSession(input.id, {
        cleanupTransientRatchetSession: false,
      });
      return sessionDataService.findAgentSessionById(input.id);
    }),

  // Restart a session (stop if running, then start with context resumption)
  restartSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionDataService, sessionService } = ctx.appContext.services;
      await sessionService.restartSession(input.id);
      return sessionDataService.findAgentSessionById(input.id);
    }),

  // Delete a session
  deleteSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionDataService, sessionService, sessionDomainService } = ctx.appContext.services;
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
    .query(({ ctx, input }) => {
      const { terminalSessionService } = ctx.appContext.services;
      const { workspaceId, ...filters } = input;
      return terminalSessionService.findWorkspaceSessions(workspaceId, filters);
    }),

  // Get terminal session by ID
  getTerminalSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { terminalSessionService } = ctx.appContext.services;
      const session = await terminalSessionService.findSession(input.id);
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
    .mutation(({ ctx, input }) => {
      const { terminalSessionService } = ctx.appContext.services;
      return terminalSessionService.registerSession(input);
    }),

  // Update a terminal session
  updateTerminalSession: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string(),
      })
    )
    .mutation(({ ctx, input }) => {
      const { terminalSessionService } = ctx.appContext.services;
      return terminalSessionService.renameSession(input.id, input.name);
    }),

  // Delete a terminal session
  deleteTerminalSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      return ctx.appContext.services.terminalSessionService.removeSession(input.id);
    }),
});
