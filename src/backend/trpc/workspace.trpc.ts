import { KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import pLimit from 'p-limit';
import { z } from 'zod';
import { gitCommand } from '../lib/shell';
import { projectAccessor } from '../resource_accessors/project.accessor';

import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from '../services/github-cli.service';

// Limit concurrent git operations to prevent resource exhaustion.
// The value 3 is arbitrary but works well in practice - high enough for parallelism,
// low enough to avoid spawning too many git processes simultaneously.
const DEFAULT_GIT_CONCURRENCY = 3;
const gitConcurrencyLimit = pLimit(DEFAULT_GIT_CONCURRENCY);

// Cache for GitHub review requests (expensive API call)
let cachedReviewCount: { count: number; fetchedAt: number } | null = null;
const REVIEW_CACHE_TTL_MS = 60_000; // 1 minute cache

import { computeKanbanColumn } from '../services/kanban-state.service';
import { createLogger } from '../services/logger.service';
import { sessionService } from '../services/session.service';
import { terminalService } from '../services/terminal.service';
import { publicProcedure, router } from './trpc';
import { workspaceFilesRouter } from './workspace/files.trpc';
import { workspaceGitRouter } from './workspace/git.trpc';
import { workspaceIdeRouter } from './workspace/ide.trpc';
import { initializeWorkspaceWorktree, workspaceInitRouter } from './workspace/init.trpc';

const logger = createLogger('workspace-trpc');

// =============================================================================
// Helper Types
// =============================================================================

export type GitFileStatus = 'M' | 'A' | 'D' | '?';

export interface GitStatusFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse git status --porcelain output into structured data.
 * Exported for testing.
 */
export function parseGitStatusOutput(output: string): GitStatusFile[] {
  // Split by newlines and filter empty lines. Don't use trim() on the whole output
  // as that removes the leading space which is part of the git status format
  // (a leading space in position 0 indicates the file is not staged).
  const lines = output.split('\n').filter((line) => line.length > 0);
  const files: GitStatusFile[] = [];

  for (const line of lines) {
    if (line.length < 4) {
      continue;
    }

    // Format: XY filename
    // X = staged status, Y = unstaged status
    const stagedStatus = line[0];
    const unstagedStatus = line[1];
    const filePath = line.slice(3);

    // Determine if file is staged (has a non-space/non-? in first column)
    const staged = stagedStatus !== ' ' && stagedStatus !== '?';

    // Determine the status to show
    let status: GitFileStatus;
    if (stagedStatus === '?' || unstagedStatus === '?') {
      status = '?';
    } else if (stagedStatus === 'A' || unstagedStatus === 'A') {
      status = 'A';
    } else if (stagedStatus === 'D' || unstagedStatus === 'D') {
      status = 'D';
    } else {
      status = 'M';
    }

    files.push({ path: filePath, status, staged });
  }

  return files;
}

/**
 * Parse git diff --numstat output to get total additions and deletions.
 */
function parseNumstatOutput(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  if (!output.trim()) {
    return { additions, deletions };
  }

  for (const line of output.trim().split('\n')) {
    const [add, del] = line.split('\t');
    // Binary files show as '-' for add/del
    if (add !== '-') {
      additions += Number.parseInt(add, 10) || 0;
    }
    if (del !== '-') {
      deletions += Number.parseInt(del, 10) || 0;
    }
  }

  return { additions, deletions };
}

/**
 * Get the merge base between HEAD and the default branch.
 * Tries local branch first, falls back to origin/.
 * Returns null if no merge base can be found.
 */
async function getMergeBase(worktreePath: string, defaultBranch: string): Promise<string | null> {
  const candidates = [defaultBranch, `origin/${defaultBranch}`];

  for (const base of candidates) {
    const result = await gitCommand(['merge-base', 'HEAD', base], worktreePath);
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return null;
}

/**
 * Fetch git stats (additions/deletions/file count) for a single workspace.
 * Returns null if the workspace has no worktree or git commands fail.
 */
async function getWorkspaceGitStats(
  worktreePath: string,
  defaultBranch: string
): Promise<{
  total: number;
  additions: number;
  deletions: number;
  hasUncommitted: boolean;
} | null> {
  // Check for uncommitted changes
  const statusResult = await gitCommand(['status', '--porcelain'], worktreePath);
  if (statusResult.code !== 0) {
    return null;
  }
  const hasUncommitted = statusResult.stdout.trim().length > 0;

  // Get merge base with the project's default branch
  const mergeBase = await getMergeBase(worktreePath, defaultBranch);

  // Get all changes from merge base (committed + uncommitted)
  const diffArgs = mergeBase ? ['diff', '--numstat', mergeBase] : ['diff', '--numstat'];
  const diffResult = await gitCommand(diffArgs, worktreePath);

  // Get file count from main-relative diff
  const fileCountArgs = mergeBase ? ['diff', '--name-only', mergeBase] : ['diff', '--name-only'];
  const fileCountResult = await gitCommand(fileCountArgs, worktreePath);
  const total =
    fileCountResult.code === 0
      ? fileCountResult.stdout
          .trim()
          .split('\n')
          .filter((l) => l.length > 0).length
      : 0;

  const { additions, deletions } =
    diffResult.code === 0 ? parseNumstatOutput(diffResult.stdout) : { additions: 0, deletions: 0 };

  return { total, additions, deletions, hasUncommitted };
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
      // 1. Fetch project (for defaultBranch) and ACTIVE workspaces with sessions in parallel
      const [project, workspaces] = await Promise.all([
        projectAccessor.findById(input.projectId),
        workspaceAccessor.findByProjectIdWithSessions(input.projectId, {
          status: WorkspaceStatus.ACTIVE,
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
            } catch {
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
        } catch {
          // Silently fail - review count is non-critical
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

      // Start worktree initialization in the background (fire-and-forget)
      // This allows the user to be redirected to the workspace page immediately
      // Errors are logged and handled inside the function (updates initStatus to FAILED)
      initializeWorkspaceWorktree(workspace.id, input.branchName);

      // Return immediately so frontend can redirect to the workspace page
      return workspace;
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
