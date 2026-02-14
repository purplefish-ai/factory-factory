import { KanbanColumn, WorkspaceStatus } from '@factory-factory/core';
import { WorkspaceProviderSelection } from '@prisma-gen/client';
import { z } from 'zod';
import { ratchetService } from '@/backend/domains/ratchet';
import { sessionService } from '@/backend/domains/session';
import {
  deriveWorkspaceFlowStateFromWorkspace,
  WorkspaceCreationService,
  workspaceDataService,
  workspaceQueryService,
} from '@/backend/domains/workspace';
import {
  buildWorkspaceSessionSummaries,
  hasWorkingSessionSummary,
} from '@/backend/lib/session-summaries';
import { archiveWorkspace } from '@/backend/orchestration/workspace-archive.orchestrator';
import { initializeWorkspaceWorktree } from '@/backend/orchestration/workspace-init.orchestrator';
import { deriveWorkspaceSidebarStatus } from '@/shared/workspace-sidebar-status';
import { type Context, publicProcedure, router } from './trpc';
import { workspaceFilesRouter } from './workspace/files.trpc';
import { workspaceGitRouter } from './workspace/git.trpc';
import { workspaceIdeRouter } from './workspace/ide.trpc';
import { workspaceInitRouter } from './workspace/init.trpc';
import { workspaceRunScriptRouter } from './workspace/run-script.trpc';
import { getWorkspaceWithProjectOrThrow } from './workspace/workspace-helpers';

const loggerName = 'workspace-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

// Zod schema for workspace creation source discriminated union
const workspaceCreationSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('MANUAL'),
    projectId: z.string(),
    name: z.string().min(1),
    description: z.string().optional(),
    branchName: z.string().optional(),
    ratchetEnabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('RESUME_BRANCH'),
    projectId: z.string(),
    branchName: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    ratchetEnabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('GITHUB_ISSUE'),
    projectId: z.string(),
    issueNumber: z.number(),
    issueUrl: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    ratchetEnabled: z.boolean().optional(),
  }),
]);

// =============================================================================
// Router
// =============================================================================

export const workspaceRouter = router({
  // List workspaces for a project
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ input }) => {
      const { projectId, ...filters } = input;
      return workspaceDataService.findByProjectId(projectId, filters);
    }),

  // Get unified project summary state for sidebar (workspaces + working status + git stats + review count)
  getProjectSummaryState: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => workspaceQueryService.getProjectSummaryState(input.projectId)),

  // List workspaces with kanban state (for board view)
  listWithKanbanState: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
        kanbanColumn: z.nativeEnum(KanbanColumn).optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
      })
    )
    .query(({ input }) => workspaceQueryService.listWithKanbanState(input)),

  // Get workspace by ID
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const workspace = await workspaceDataService.findById(input.id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.id}`);
    }
    const flowState = deriveWorkspaceFlowStateFromWorkspace(workspace);
    const sessionSummaries = buildWorkspaceSessionSummaries(workspace.agentSessions ?? [], (id) =>
      sessionService.getRuntimeSnapshot(id)
    );
    const isSessionWorking = hasWorkingSessionSummary(sessionSummaries);
    const isWorking = isSessionWorking || flowState.isWorking;
    return {
      ...workspace,
      sessionSummaries,
      sidebarStatus: deriveWorkspaceSidebarStatus({
        isWorking,
        prUrl: workspace.prUrl,
        prState: workspace.prState,
        prCiStatus: workspace.prCiStatus,
        ratchetState: workspace.ratchetState,
      }),
      ratchetButtonAnimated: flowState.shouldAnimateRatchetButton,
      flowPhase: flowState.phase,
      ciObservation: flowState.ciObservation,
    };
  }),

  // Create a new workspace
  create: publicProcedure.input(workspaceCreationSourceSchema).mutation(async ({ ctx, input }) => {
    const logger = getLogger(ctx);
    const { configService } = ctx.appContext.services;

    // Use the canonical workspace creation service
    const workspaceCreationService = new WorkspaceCreationService({
      logger,
      configService,
    });

    const { workspace } = await workspaceCreationService.create(input);

    const branchName =
      input.type === 'MANUAL'
        ? input.branchName
        : input.type === 'RESUME_BRANCH'
          ? input.branchName
          : undefined;
    const useExistingBranch = input.type === 'RESUME_BRANCH';

    void initializeWorkspaceWorktree(workspace.id, {
      branchName,
      useExistingBranch,
    }).catch((error) => {
      const initError = error instanceof Error ? error : new Error(String(error));
      logger.error('Unexpected error during background workspace initialization', initError, {
        workspaceId: workspace.id,
      });
    });

    return workspace;
  }),

  // Toggle workspace-level ratcheting
  toggleRatcheting: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await ratchetService.setWorkspaceRatcheting(input.workspaceId, input.enabled);
      if (input.enabled) {
        await ratchetService.checkWorkspaceById(input.workspaceId);
      }
      const updatedWorkspace = await workspaceDataService.findById(input.workspaceId);
      if (!updatedWorkspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }
      return updatedWorkspace;
    }),

  // Update workspace provider defaults (session + ratchet).
  updateProviderDefaults: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        defaultSessionProvider: z.nativeEnum(WorkspaceProviderSelection).optional(),
        ratchetSessionProvider: z.nativeEnum(WorkspaceProviderSelection).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const updated = await workspaceDataService.update(input.workspaceId, {
        defaultSessionProvider: input.defaultSessionProvider,
        ratchetSessionProvider: input.ratchetSessionProvider,
      });
      return updated;
    }),

  // Archive a workspace
  archive: publicProcedure
    .input(z.object({ id: z.string(), commitUncommitted: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const workspace = await getWorkspaceWithProjectOrThrow(input.id);
      return archiveWorkspace(workspace, {
        commitUncommitted: input.commitUncommitted ?? true,
      });
    }),

  // Delete a workspace
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const { runScriptService, sessionService, terminalService } = ctx.appContext.services;
    const logger = getLogger(ctx);
    // Clean up running sessions, terminals, and dev processes before deleting
    try {
      await sessionService.stopWorkspaceSessions(input.id);
      await runScriptService.stopRunScript(input.id);
      terminalService.destroyWorkspaceTerminals(input.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before delete', {
        workspaceId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspaceDataService.delete(input.id);
  }),

  // Refresh factory-factory.json configuration for all workspaces
  refreshFactoryConfigs: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ input }) => workspaceQueryService.refreshFactoryConfigs(input.projectId)),

  // Get factory-factory.json configuration for a project
  getFactoryConfig: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => workspaceQueryService.getFactoryConfig(input.projectId)),

  // Sync PR status for a workspace (immediate refresh from GitHub)
  syncPRStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ input }) => workspaceQueryService.syncPRStatus(input.workspaceId)),

  // Sync PR status for all workspaces in a project (immediate refresh from GitHub)
  syncAllPRStatuses: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(({ input }) => workspaceQueryService.syncAllPRStatuses(input.projectId)),

  // Check if workspace branch has changes relative to the project's default branch
  hasChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ input }) => workspaceQueryService.hasChanges(input.workspaceId)),

  // Merge sub-routers
  ...workspaceFilesRouter._def.procedures,
  ...workspaceGitRouter._def.procedures,
  ...workspaceIdeRouter._def.procedures,
  ...workspaceInitRouter._def.procedures,
  ...workspaceRunScriptRouter._def.procedures,
});
