import { SessionStatus } from '@prisma-gen/client';
import { z } from 'zod';
import { getQuickAction, listQuickActions } from '../prompts/quick-actions';
import { DEFAULT_FIRST_SESSION, DEFAULT_FOLLOWUP, listWorkflows } from '../prompts/workflows';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { terminalSessionAccessor } from '../resource_accessors/terminal-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { sessionService } from '../services/session.service';
import { publicProcedure, router } from './trpc';

export const sessionRouter = router({
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
        claudeSessionId: z.string().optional(),
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
      // Fetch all sessions for all workspaces in a single query
      const sessions = await claudeSessionAccessor.findByWorkspaceIds(input.workspaceIds);

      // Group sessions by workspace ID
      const sessionsByWorkspace = new Map<string, string[]>();
      for (const workspaceId of input.workspaceIds) {
        sessionsByWorkspace.set(workspaceId, []);
      }
      for (const session of sessions) {
        sessionsByWorkspace.get(session.workspaceId)?.push(session.id);
      }

      // Check working status for each workspace
      const result: Record<string, boolean> = {};
      for (const [workspaceId, sessionIds] of sessionsByWorkspace) {
        result[workspaceId] = sessionService.isAnySessionWorking(sessionIds);
      }
      return result;
    }),
});
