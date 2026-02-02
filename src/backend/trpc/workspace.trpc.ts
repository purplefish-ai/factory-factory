import { KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { z } from 'zod';
import { getWorkspaceGitStats } from '../lib/git-helpers';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { eventsHubService } from '../services/events-hub.service';
import { eventsPollerService } from '../services/events-poller.service';
import { eventsSnapshotService } from '../services/events-snapshot.service';
import { FactoryConfigService } from '../services/factory-config.service';
import { githubCLIService } from '../services/github-cli.service';
import { computeKanbanColumn, kanbanStateService } from '../services/kanban-state.service';
import { createLogger } from '../services/logger.service';
import { sessionService } from '../services/session.service';
import { terminalService } from '../services/terminal.service';
import { workspaceStateMachine } from '../services/workspace-state-machine.service';
import { publicProcedure, router } from './trpc';
import { workspaceFilesRouter } from './workspace/files.trpc';
import { workspaceGitRouter } from './workspace/git.trpc';
import { workspaceIdeRouter } from './workspace/ide.trpc';
import { initializeWorkspaceWorktree, workspaceInitRouter } from './workspace/init.trpc';
import { workspaceRunScriptRouter } from './workspace/run-script.trpc';

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

async function publishWorkspaceSnapshots(projectId: string, workspaceId?: string): Promise<void> {
  const subscribedProjects = eventsHubService.getSubscribedProjectIds();
  if (!subscribedProjects.has(projectId)) {
    return;
  }

  const [listSnapshot, kanbanSnapshot, summarySnapshot] = await Promise.all([
    eventsSnapshotService.getWorkspaceListSnapshot(projectId),
    eventsSnapshotService.getKanbanSnapshot(projectId),
    eventsSnapshotService.getProjectSummarySnapshot(
      projectId,
      eventsPollerService.getReviewCount()
    ),
  ]);

  eventsHubService.publishSnapshot({
    type: listSnapshot.type,
    payload: listSnapshot,
    cacheKey: `workspace-list:${projectId}`,
    projectId,
  });

  eventsHubService.publishSnapshot({
    type: kanbanSnapshot.type,
    payload: kanbanSnapshot,
    cacheKey: `kanban:${projectId}`,
    projectId,
  });

  eventsHubService.publishSnapshot({
    type: summarySnapshot.type,
    payload: summarySnapshot,
    cacheKey: `project-summary:${projectId}`,
    projectId,
  });

  if (workspaceId) {
    const detailSnapshot = await eventsSnapshotService.getWorkspaceDetailSnapshot(workspaceId);
    if (detailSnapshot) {
      eventsHubService.publishSnapshot({
        type: detailSnapshot.type,
        payload: detailSnapshot,
        cacheKey: `workspace-detail:${workspaceId}`,
        workspaceId,
      });
    }
  }
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
    .query(async ({ input }) => {
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

      try {
        await publishWorkspaceSnapshots(workspace.projectId, workspace.id);
      } catch (error) {
        logger.debug('Failed to publish workspace snapshots', {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

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
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;
      const workspace = await workspaceAccessor.update(id, updates);

      try {
        await publishWorkspaceSnapshots(workspace.projectId, workspace.id);
      } catch (error) {
        logger.debug('Failed to publish workspace snapshots', {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return workspace;
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
    const workspace = await workspaceStateMachine.archive(input.id);
    try {
      await publishWorkspaceSnapshots(workspace.projectId, workspace.id);
    } catch (error) {
      logger.debug('Failed to publish workspace snapshots', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspace;
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
    const workspace = await workspaceAccessor.delete(input.id);
    try {
      await publishWorkspaceSnapshots(workspace.projectId);
    } catch (error) {
      logger.debug('Failed to publish workspace snapshots', {
        workspaceId: input.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return workspace;
  }),

  // Refresh factory-factory.json configuration for all workspaces
  refreshFactoryConfigs: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input }) => {
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
    .query(async ({ input }) => {
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
    .mutation(async ({ input }) => {
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
    .mutation(async ({ input }) => {
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

  // Merge sub-routers
  ...workspaceFilesRouter._def.procedures,
  ...workspaceGitRouter._def.procedures,
  ...workspaceIdeRouter._def.procedures,
  ...workspaceInitRouter._def.procedures,
  ...workspaceRunScriptRouter._def.procedures,
});
