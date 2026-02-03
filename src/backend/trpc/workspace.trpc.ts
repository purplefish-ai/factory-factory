import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import pLimit from 'p-limit';
import { z } from 'zod';
import { GitClientFactory } from '../clients/git.client';
import { getWorkspaceGitStats } from '../lib/git-helpers';
import { gitCommand } from '../lib/shell';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { FactoryConfigService } from '../services/factory-config.service';
import { computeKanbanColumn } from '../services/kanban-state.service';
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

// Limit concurrent git operations to prevent resource exhaustion.
// The value 3 is arbitrary but works well in practice - high enough for parallelism,
// low enough to avoid spawning too many git processes simultaneously.
const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

// Cache for GitHub review requests (expensive API call)
let cachedReviewCount: { count: number; fetchedAt: number } | null = null;
const REVIEW_CACHE_TTL_MS = 60_000; // 1 minute cache

type WorkspaceWithProject = Awaited<ReturnType<typeof getWorkspaceWithProjectOrThrow>>;

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
}

function getProjectOrThrow(workspace: WorkspaceWithProject) {
  const project = workspace.project;
  if (!(project?.repoPath && project.worktreeBasePath)) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Workspace project paths are missing',
    });
  }
  return project;
}

function assertWorktreePathSafe(worktreePath: string, worktreeBasePath: string): void {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedBasePath = path.resolve(worktreeBasePath);
  const basePrefix = `${resolvedBasePath}${path.sep}`;

  if (resolvedWorktreePath === resolvedBasePath || !resolvedWorktreePath.startsWith(basePrefix)) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Workspace worktree path is outside the worktree base directory',
    });
  }
}

function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

async function commitIfNeeded(
  worktreePath: string,
  workspaceName: string,
  commitUncommitted: boolean
): Promise<void> {
  const statusResult = await gitCommand(['status', '--porcelain'], worktreePath);
  if (statusResult.code !== 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Git status failed: ${statusResult.stderr || statusResult.stdout}`,
    });
  }

  if (statusResult.stdout.trim().length === 0) {
    return;
  }

  if (!commitUncommitted) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Workspace has uncommitted changes. Enable commit-before-archive to proceed.',
    });
  }

  const addResult = await gitCommand(['add', '-A'], worktreePath);
  if (addResult.code !== 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Git add failed: ${addResult.stderr || addResult.stdout}`,
    });
  }

  const commitMessage = `Archive workspace ${workspaceName}`;
  const commitResult = await gitCommand(['commit', '-m', commitMessage], worktreePath);
  if (commitResult.code !== 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Git commit failed: ${commitResult.stderr || commitResult.stdout}`,
    });
  }
}

async function removeWorktree(
  worktreePath: string,
  project: { repoPath: string; worktreeBasePath: string }
): Promise<void> {
  const gitClient = GitClientFactory.forProject({
    repoPath: project.repoPath,
    worktreeBasePath: project.worktreeBasePath,
  });
  const worktreeName = path.basename(worktreePath);

  const registeredWorktree = await gitClient.checkWorktreeExists(worktreeName);
  if (registeredWorktree) {
    await gitClient.deleteWorktree(worktreeName);
    return;
  }

  if (await pathExists(worktreePath)) {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

async function cleanupWorkspaceWorktree(
  workspace: WorkspaceWithProject,
  options: WorktreeCleanupOptions
): Promise<void> {
  const worktreePath = workspace.worktreePath;
  if (!worktreePath) {
    return;
  }

  const project = getProjectOrThrow(workspace);
  assertWorktreePathSafe(worktreePath, project.worktreeBasePath);

  const worktreeExists = await pathExists(worktreePath);
  if (!worktreeExists) {
    return;
  }

  await commitIfNeeded(worktreePath, workspace.name, options.commitUncommitted);
  await removeWorktree(worktreePath, project);
}

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
    .query(async ({ ctx, input }) => {
      const { githubCLIService, sessionService } = ctx.appContext.services;
      const logger = getLogger(ctx);
      // 1. Fetch project (for defaultBranch) and non-archived workspaces with sessions in parallel
      const [project, workspaces] = await Promise.all([
        projectAccessor.findById(input.projectId),
        workspaceAccessor.findByProjectIdWithSessions(input.projectId, {
          excludeStatuses: [WorkspaceStatus.ARCHIVED],
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
        workspaces: workspaces.map((w) => {
          // Compute last activity from most recent session (Claude or Terminal)
          // Returns null if no sessions exist (avoid misleading timestamps from metadata changes)
          const sessionDates = [
            ...(w.claudeSessions?.map((s) => s.updatedAt) ?? []),
            ...(w.terminalSessions?.map((s) => s.updatedAt) ?? []),
          ].filter(Boolean) as Date[];
          const lastActivityAt =
            sessionDates.length > 0
              ? sessionDates.reduce((latest, d) => (d > latest ? d : latest)).toISOString()
              : null;

          return {
            id: w.id,
            name: w.name,
            branchName: w.branchName,
            prUrl: w.prUrl,
            prNumber: w.prNumber,
            prState: w.prState,
            prCiStatus: w.prCiStatus,
            isWorking: workingStatusByWorkspace.get(w.id) ?? false,
            gitStats: gitStatsResults[w.id] ?? null,
            lastActivityAt,
          };
        }),
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
    .query(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
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
    .mutation(async ({ ctx, input }) => {
      const { runScriptService, sessionService, terminalService, workspaceStateMachine } =
        ctx.appContext.services;
      const logger = getLogger(ctx);
      const workspace = await getWorkspaceWithProjectOrThrow(input.id);
      if (!workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVED')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot archive workspace from status: ${workspace.status}`,
        });
      }

      // Clean up running sessions, terminals, and dev processes before archiving
      try {
        await sessionService.stopWorkspaceSessions(input.id);
        await runScriptService.stopRunScript(input.id);
        terminalService.destroyWorkspaceTerminals(input.id);
      } catch (error) {
        logger.error('Failed to cleanup workspace resources before archive', {
          workspaceId: input.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await cleanupWorkspaceWorktree(workspace, {
          commitUncommitted: input.commitUncommitted ?? true,
        });
      } catch (error) {
        logger.error('Failed to cleanup workspace worktree before archive', {
          workspaceId: input.id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return workspaceStateMachine.archive(input.id);
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
    .mutation(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      // Get all workspaces for this project that have worktrees
      const workspaces = await workspaceAccessor.findByProjectId(input.projectId);

      let updatedCount = 0;
      const errors: Array<{ workspaceId: string; error: string }> = [];

      for (const workspace of workspaces) {
        if (!workspace.worktreePath) {
          continue;
        }

        try {
          // Read factory-factory.json from the worktree
          const factoryConfig = await FactoryConfigService.readConfig(workspace.worktreePath);

          // Update workspace with new config
          await workspaceAccessor.update(workspace.id, {
            runScriptCommand: factoryConfig?.scripts.run ?? null,
            runScriptCleanupCommand: factoryConfig?.scripts.cleanup ?? null,
          });

          updatedCount++;
        } catch (error) {
          errors.push({
            workspaceId: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
          logger.error('Failed to refresh factory config for workspace', {
            workspaceId: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        updatedCount,
        totalWorkspaces: workspaces.length,
        errors,
      };
    }),

  // Get factory-factory.json configuration for a project
  getFactoryConfig: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const logger = getLogger(ctx);
      const project = await projectAccessor.findById(input.projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      try {
        const config = await FactoryConfigService.readConfig(project.repoPath);
        return config;
      } catch (error) {
        logger.error('Failed to read factory config', {
          projectId: input.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),

  // Sync PR status for a workspace (immediate refresh from GitHub)
  syncPRStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { githubCLIService, kanbanStateService } = ctx.appContext.services;
      const logger = getLogger(ctx);
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }

      if (!workspace.prUrl) {
        return { success: false, reason: 'no_pr_url' as const };
      }

      const prResult = await githubCLIService.fetchAndComputePRState(workspace.prUrl);
      if (!prResult) {
        return { success: false, reason: 'fetch_failed' as const };
      }

      await workspaceAccessor.update(input.workspaceId, {
        prNumber: prResult.prNumber,
        prState: prResult.prState,
        prReviewState: prResult.prReviewState,
        prCiStatus: prResult.prCiStatus,
        prUpdatedAt: new Date(),
      });

      await kanbanStateService.updateCachedKanbanColumn(input.workspaceId);

      logger.info('PR status synced manually', {
        workspaceId: input.workspaceId,
        prNumber: prResult.prNumber,
        prState: prResult.prState,
      });

      return { success: true, prState: prResult.prState };
    }),

  // Sync PR status for all workspaces in a project (immediate refresh from GitHub)
  syncAllPRStatuses: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { githubCLIService, kanbanStateService } = ctx.appContext.services;
      const logger = getLogger(ctx);
      const workspaces = await workspaceAccessor.findByProjectIdWithSessions(input.projectId, {
        excludeStatuses: [WorkspaceStatus.ARCHIVED],
      });

      const workspacesWithPRs = workspaces.filter(
        (w): w is typeof w & { prUrl: string } => w.prUrl !== null
      );

      if (workspacesWithPRs.length === 0) {
        return { synced: 0, failed: 0 };
      }

      let synced = 0;
      let failed = 0;

      // Sync all workspaces with PRs (with concurrency limit)
      await Promise.all(
        workspacesWithPRs.map((workspace) =>
          gitConcurrencyLimit(async () => {
            const prResult = await githubCLIService.fetchAndComputePRState(workspace.prUrl);
            if (!prResult) {
              failed++;
              return;
            }

            await workspaceAccessor.update(workspace.id, {
              prNumber: prResult.prNumber,
              prState: prResult.prState,
              prReviewState: prResult.prReviewState,
              prCiStatus: prResult.prCiStatus,
              prUpdatedAt: new Date(),
            });

            await kanbanStateService.updateCachedKanbanColumn(workspace.id);
            synced++;
          })
        )
      );

      logger.info('Batch PR status sync completed', { projectId: input.projectId, synced, failed });

      return { synced, failed };
    }),

  // Check if workspace branch has changes relative to the project's default branch
  hasChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findByIdWithProject(input.workspaceId);
      if (!(workspace?.worktreePath && workspace.project)) {
        return false;
      }

      try {
        const stats = await getWorkspaceGitStats(
          workspace.worktreePath,
          workspace.project.defaultBranch ?? 'main'
        );
        return stats !== null && (stats.total > 0 || stats.hasUncommitted);
      } catch {
        return false;
      }
    }),

  // Merge sub-routers
  ...workspaceFilesRouter._def.procedures,
  ...workspaceGitRouter._def.procedures,
  ...workspaceIdeRouter._def.procedures,
  ...workspaceInitRouter._def.procedures,
  ...workspaceRunScriptRouter._def.procedures,
});
