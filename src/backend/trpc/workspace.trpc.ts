import { KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import { z } from 'zod';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { workspaceQueryService } from '../services/workspace-query.service';
import { worktreeLifecycleService } from '../services/worktree-lifecycle.service';
import { type Context, publicProcedure, router } from './trpc';
import { workspaceFilesRouter } from './workspace/files.trpc';
import { workspaceGitRouter } from './workspace/git.trpc';
import { workspaceIdeRouter } from './workspace/ide.trpc';
import { initializeWorkspaceWorktree, workspaceInitRouter } from './workspace/init.trpc';
import { workspaceRunScriptRouter } from './workspace/run-script.trpc';
import { getWorkspaceWithProjectOrThrow } from './workspace/workspace-helpers';

// Re-export types for backward compatibility
export type { GitFileStatus, GitStatusFile } from '../lib/git-helpers';
export { parseGitStatusOutput } from '../lib/git-helpers';

const loggerName = 'workspace-trpc';
const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

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
      return workspaceAccessor.findByProjectId(projectId, filters);
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
    const workspace = await workspaceAccessor.findById(input.id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.id}`);
    }
    return workspace;
  }),

  // Create a new workspace
  create: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        branchName: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      // Create the workspace record
      const workspace = await workspaceAccessor.create(input);

      // Initialize the worktree in the background so the frontend can navigate
      // immediately. The workspace detail page polls for initialization status
      // and shows an overlay spinner until the workspace is fully ready.
      // The function has internal error handling but we add a catch here to handle
      // any unexpected errors (e.g., if markFailed throws due to DB issues).
      initializeWorkspaceWorktree(workspace.id, input.branchName).catch((error) => {
        logger.error(
          'Unexpected error during background workspace initialization',
          error as Error,
          {
            workspaceId: workspace.id,
          }
        );
      });

      return workspace;
    }),

  // Update a workspace
  // Note: status changes should go through dedicated endpoints (archive, retryInit, etc.)
  // to ensure state machine validation
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        worktreePath: z.string().optional(),
        branchName: z.string().optional(),
        prUrl: z.string().optional(),
        githubIssueNumber: z.number().optional(),
        githubIssueUrl: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      return workspaceAccessor.update(id, updates);
    }),

  // Archive a workspace
  archive: publicProcedure
    .input(z.object({ id: z.string(), commitUncommitted: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const workspace = await getWorkspaceWithProjectOrThrow(input.id);
      return worktreeLifecycleService.archiveWorkspace(workspace, {
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
    return workspaceAccessor.delete(input.id);
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

  // Mark workspace as seen (clears needsAttention flag)
  markAsSeen: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      await workspaceAccessor.update(input.workspaceId, { needsAttention: false });
      return { success: true };
    }),

  // Merge sub-routers
  ...workspaceFilesRouter._def.procedures,
  ...workspaceGitRouter._def.procedures,
  ...workspaceIdeRouter._def.procedures,
  ...workspaceInitRouter._def.procedures,
  ...workspaceRunScriptRouter._def.procedures,
});
