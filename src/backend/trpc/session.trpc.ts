import { SessionStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getQuickAction, listQuickActions } from '../prompts/quick-actions';
import { DEFAULT_FIRST_SESSION, DEFAULT_FOLLOWUP, listWorkflows } from '../prompts/workflows';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { terminalSessionAccessor } from '../resource_accessors/terminal-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { configService } from '../services/config.service';
import { eventsHubService } from '../services/events-hub.service';
import { eventsSnapshotService } from '../services/events-snapshot.service';
import { messageQueueService } from '../services/message-queue.service';
import { sessionService } from '../services/session.service';
import { publicProcedure, router } from './trpc';

async function publishSessionListSnapshot(workspaceId: string): Promise<void> {
  const subscribed = eventsHubService.getSubscribedWorkspaceIds();
  if (!subscribed.has(workspaceId)) {
    return;
  }
  const snapshot = await eventsSnapshotService.getSessionListSnapshot(workspaceId);
  eventsHubService.publishSnapshot({
    type: snapshot.type,
    payload: snapshot,
    cacheKey: `session-list:${workspaceId}`,
    workspaceId,
  });
}

export const sessionRouter = router({
  // Session limits

  // Get the maximum number of sessions allowed per workspace
  getMaxSessionsPerWorkspace: publicProcedure.query(() => {
    return configService.getMaxSessionsPerWorkspace();
  }),

  // Workflows

  // List all available workflows
  listWorkflows: publicProcedure.query(() => listWorkflows()),

  // Get recommended workflow for a workspace (feature for first session, followup otherwise)
  getRecommendedWorkflow: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      return workspace?.hasHadSessions ? DEFAULT_FOLLOWUP : DEFAULT_FIRST_SESSION;
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
    .query(async ({ input }) => {
      const { workspaceId, ...filters } = input;
      const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId, filters);
      // Augment sessions with real-time working status from in-memory process state
      return sessions.map((session) => ({
        ...session,
        isWorking: sessionService.isSessionWorking(session.id),
      }));
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
    .mutation(async ({ input }) => {
      // Check per-workspace session limit
      const maxSessions = configService.getMaxSessionsPerWorkspace();
      const existingSessions = await claudeSessionAccessor.findByWorkspaceId(input.workspaceId);

      if (existingSessions.length >= maxSessions) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Maximum sessions per workspace (${maxSessions}) reached`,
        });
      }

      const session = await claudeSessionAccessor.create(input);
      try {
        await publishSessionListSnapshot(input.workspaceId);
      } catch {
        // Best-effort snapshot publish
      }
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
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;
      const session = await claudeSessionAccessor.update(id, updates);
      try {
        await publishSessionListSnapshot(session.workspaceId);
      } catch {
        // Best-effort snapshot publish
      }
      return session;
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
      const session = await claudeSessionAccessor.findById(input.id);
      if (session) {
        try {
          await publishSessionListSnapshot(session.workspaceId);
        } catch {
          // Best-effort snapshot publish
        }
      }
      return session;
    }),

  // Stop a claude session (gracefully stops the process)
  stopClaudeSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await sessionService.stopClaudeSession(input.id);
      const session = await claudeSessionAccessor.findById(input.id);
      if (session) {
        try {
          await publishSessionListSnapshot(session.workspaceId);
        } catch {
          // Best-effort snapshot publish
        }
      }
      return session;
    }),

  // Delete a claude session
  deleteClaudeSession: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Stop process first to prevent orphaned Claude processes
      await sessionService.stopClaudeSession(input.id);
      // Clear any queued messages to prevent memory leak
      messageQueueService.clear(input.id);
      const session = await claudeSessionAccessor.delete(input.id);
      try {
        await publishSessionListSnapshot(session.workspaceId);
      } catch {
        // Best-effort snapshot publish
      }
      return session;
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
});
