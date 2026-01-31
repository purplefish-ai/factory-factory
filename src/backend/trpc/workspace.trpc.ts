import { KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { z } from 'zod';
import { getWorkspaceGitStats } from '../lib/git-helpers';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from '../services/github-cli.service';
import { computeKanbanColumn } from '../services/kanban-state.service';
import { createLogger } from '../services/logger.service';
import { sessionService } from '../services/session.service';
import { terminalService } from '../services/terminal.service';
import { publicProcedure, router } from './trpc';
import { workspaceFilesRouter } from './workspace/files.trpc';
import { workspaceGitRouter } from './workspace/git.trpc';
import { workspaceIdeRouter } from './workspace/ide.trpc';
import { initializeWorkspaceWorktree, workspaceInitRouter } from './workspace/init.trpc';

// Re-export types for backward compatibility
export type { GitFileStatus, GitStatusFile } from '../lib/git-helpers';
export { parseGitStatusOutput } from '../lib/git-helpers';

const logger = createLogger('workspace-trpc');

// Limit concurrent git operations to prevent resource exhaustion.
// The value 3 is arbitrary but works well in practice - high enough for parallelism,
// low enough to avoid spawning too many git processes simultaneously.
const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

// Cache for GitHub review requests (expensive API call)
let cachedReviewCount: { count: number; fetchedAt: number } | null = null;
const REVIEW_CACHE_TTL_MS = 60_000; // 1 minute cache

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
    .query(async ({ input }) => {
      // 1. Fetch project (for defaultBranch) and READY workspaces with sessions in parallel
      const [project, workspaces] = await Promise.all([
        projectAccessor.findById(input.projectId),
        workspaceAccessor.findByProjectIdWithSessions(input.projectId, {
          status: WorkspaceStatus.READY,
        }),
      ]);

      const defaultBranch = project?.defaultBranch ?? 'main';

      // 2. Compute working status for each workspace
      const workingStatusByWorkspace = new Map<string, boolean>();
      for (const workspace of workspaces) {
        const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
        workingStatusByWorkspace.set(workspace.id, sessionService.isAnySessionWorking(sessionIds));
      }

      // 3. Fetch git stats for all workspaces with concurrency limit
      const gitStatsResults: Record<
        string,
        { total: number; additions: number; deletions: number; hasUncommitted: boolean } | null
      > = {};

      await Promise.all(
        workspaces.map((workspace) =>
          gitConcurrencyLimit(async () => {
            if (!workspace.worktreePath) {
              gitStatsResults[workspace.id] = null;
              return;
            }
            try {
              gitStatsResults[workspace.id] = await getWorkspaceGitStats(
                workspace.worktreePath,
                defaultBranch
              );
            } catch (error) {
              logger.debug('Failed to get git stats for workspace', {
                workspaceId: workspace.id,
                error: error instanceof Error ? error.message : String(error),
              });
              gitStatsResults[workspace.id] = null;
            }
          })
        )
      );

      // 4. Fetch review count (unapproved PRs only) with caching
      let reviewCount = 0;
      const now = Date.now();
      if (cachedReviewCount && now - cachedReviewCount.fetchedAt < REVIEW_CACHE_TTL_MS) {
        reviewCount = cachedReviewCount.count;
      } else {
        try {
          const health = await githubCLIService.checkHealth();
          if (health.isInstalled && health.isAuthenticated) {
            const prs = await githubCLIService.listReviewRequests();
            reviewCount = prs.filter((pr) => pr.reviewDecision !== 'APPROVED').length;
            cachedReviewCount = { count: reviewCount, fetchedAt: now };
          }
        } catch (error) {
          // Review count is non-critical, but log for debugging
          logger.debug('Failed to fetch review count', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 5. Build response
      return {
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          branchName: w.branchName,
          prUrl: w.prUrl,
          prNumber: w.prNumber,
          prState: w.prState,
          prCiStatus: w.prCiStatus,
          isWorking: workingStatusByWorkspace.get(w.id) ?? false,
          gitStats: gitStatsResults[w.id] ?? null,
        })),
        reviewCount,
      };
    }),

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
    .query(async ({ input }) => {
      const { projectId, ...filters } = input;

      // Get workspaces with sessions included (exclude archived from kanban view at DB level)
      const workspaces = await workspaceAccessor.findByProjectIdWithSessions(projectId, {
        ...filters,
        excludeStatuses: [WorkspaceStatus.ARCHIVED],
      });

      // Get working status for all workspaces
      const workspacesWithKanban = workspaces.map((workspace) => {
        const sessionIds = workspace.claudeSessions?.map((s) => s.id) ?? [];
        const isWorking = sessionService.isAnySessionWorking(sessionIds);

        // Compute live kanban column
        const kanbanColumn = computeKanbanColumn({
          lifecycle: workspace.status,
          isWorking,
          prState: workspace.prState,
          hasHadSessions: workspace.hasHadSessions,
        });

        return {
          ...workspace,
          kanbanColumn,
          isWorking,
        };
      });

      return workspacesWithKanban;
    }),

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
    .mutation(async ({ input }) => {
      // Create the workspace record
      const workspace = await workspaceAccessor.create(input);

      // Initialize the worktree synchronously so workspace is ready when returned
      // This ensures worktreePath is set before the user can start sessions
      await initializeWorkspaceWorktree(workspace.id, input.branchName);

      // Refetch workspace to get updated worktreePath and status
      const initializedWorkspace = await workspaceAccessor.findById(workspace.id);

      return initializedWorkspace ?? workspace;
    }),

  // Update a workspace
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z.nativeEnum(WorkspaceStatus).optional(),
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
  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Clean up running sessions and terminals before archiving
    try {
      await sessionService.stopWorkspaceSessions(input.id);
      terminalService.destroyWorkspaceTerminals(input.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before archive', {
        workspaceId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspaceAccessor.archive(input.id);
  }),

  // Delete a workspace
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Clean up running sessions and terminals before deleting
    try {
      await sessionService.stopWorkspaceSessions(input.id);
      terminalService.destroyWorkspaceTerminals(input.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before delete', {
        workspaceId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspaceAccessor.delete(input.id);
  }),

  // Merge sub-routers
  ...workspaceFilesRouter._def.procedures,
  ...workspaceGitRouter._def.procedures,
  ...workspaceIdeRouter._def.procedures,
  ...workspaceInitRouter._def.procedures,
});
