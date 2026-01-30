import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { KanbanColumn, WorkspaceStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import pLimit from 'p-limit';
import { z } from 'zod';
import { GitClientFactory } from '../clients/git.client';
import { execCommand, gitCommand } from '../lib/shell';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { userSettingsAccessor } from '../resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from '../services/github-cli.service';

// Cache the authenticated GitHub username (fetched once per server lifetime)
let cachedGitHubUsername: string | null | undefined;

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
import { startupScriptService } from '../services/startup-script.service';
import { terminalService } from '../services/terminal.service';
import { publicProcedure, router } from './trpc';

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

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
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
 * Validate that a file path doesn't escape the worktree directory.
 * Uses path normalization and realpath to handle encoded sequences,
 * symlinks, and other bypass attempts.
 */
async function isPathSafe(worktreePath: string, filePath: string): Promise<boolean> {
  // Normalize the file path first to handle encoded sequences and resolve ./ etc
  const normalizedPath = path.normalize(filePath);

  // Check for path traversal attempts after normalization
  if (
    normalizedPath.startsWith('..') ||
    normalizedPath.includes(`${path.sep}..${path.sep}`) ||
    normalizedPath.includes(`${path.sep}..`) ||
    normalizedPath.startsWith(path.sep)
  ) {
    return false;
  }

  // Resolve the full path and ensure it's within the worktree
  const fullPath = path.resolve(worktreePath, normalizedPath);
  const normalizedWorktree = path.resolve(worktreePath);

  // Initial check before file exists
  if (!fullPath.startsWith(normalizedWorktree + path.sep) && fullPath !== normalizedWorktree) {
    return false;
  }

  // If the file exists, resolve symlinks and verify the real path is still within worktree
  try {
    const realFullPath = await realpath(fullPath);
    const realWorktree = await realpath(normalizedWorktree);
    return realFullPath.startsWith(realWorktree + path.sep) || realFullPath === realWorktree;
  } catch {
    // File doesn't exist yet (e.g., for new file creation) - rely on the initial check
    return true;
  }
}

/**
 * Get language from file extension for syntax highlighting
 */
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    prisma: 'prisma',
  };
  return langMap[ext ?? ''] ?? 'text';
}

/**
 * Check if content is binary by looking for null bytes
 */
function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

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

/**
 * IDE configurations for detection and launching
 */
const IDE_CONFIGS: Record<
  string,
  {
    cliCommand: string;
    macAppName?: string;
    macBundleId?: string;
  }
> = {
  cursor: {
    cliCommand: 'cursor',
    macAppName: 'Cursor',
    macBundleId: 'com.todesktop.230313mzl4w4u92',
  },
  vscode: {
    cliCommand: 'code',
    macAppName: 'Visual Studio Code',
    macBundleId: 'com.microsoft.VSCode',
  },
};

/**
 * Check if an IDE is available on the system
 */
async function checkIdeAvailable(ide: string): Promise<boolean> {
  const config = IDE_CONFIGS[ide];
  if (!config) {
    return false;
  }

  // Check if CLI is in PATH
  try {
    await execCommand('which', [config.cliCommand]);
    return true;
  } catch {
    // CLI not in PATH, check for macOS app
    if (process.platform === 'darwin' && config.macBundleId) {
      try {
        const result = await execCommand('mdfind', [
          `kMDItemCFBundleIdentifier == "${config.macBundleId}"`,
        ]);
        if (result.stdout.trim()) {
          return true;
        }
      } catch {
        // mdfind failed
      }
    }
    return false;
  }
}

/**
 * Execute a custom IDE command with path substitution
 */
async function openCustomIde(customCommand: string, targetPath: string): Promise<boolean> {
  // Validate command doesn't contain shell metacharacters for security
  if (/[;&|`$()[\]{}]/.test(customCommand)) {
    throw new Error('Custom command contains invalid characters');
  }

  // Properly escape the workspace path
  const escapedPath = targetPath.replace(/"/g, '\\"');
  const quotedPath = targetPath.includes(' ') ? `"${escapedPath}"` : targetPath;

  // Replace placeholders in custom command
  const command = customCommand.replace(/\{workspace\}/g, quotedPath);

  // Parse command and arguments - split on whitespace but preserve quoted strings
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cmd = parts[0]?.replace(/"/g, '');
  const args = parts.slice(1).map((arg) => arg.replace(/"/g, ''));

  if (!cmd) {
    return false;
  }

  try {
    await execCommand(cmd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a built-in IDE using its CLI or macOS app
 */
async function openBuiltInIde(ide: string, targetPath: string): Promise<boolean> {
  const config = IDE_CONFIGS[ide];
  if (!config) {
    return false;
  }

  // Try CLI command first
  try {
    await execCommand(config.cliCommand, [targetPath]);
    return true;
  } catch {
    // Fallback to 'open -a' on macOS
    if (process.platform === 'darwin' && config.macAppName) {
      try {
        await execCommand('open', ['-a', config.macAppName, targetPath]);
        return true;
      } catch {
        // Failed to open
      }
    }
    return false;
  }
}

/**
 * Open a path in the specified IDE
 * @param ide - IDE identifier ('cursor', 'vscode', or 'custom')
 * @param targetPath - Path to open
 * @param customCommand - Custom command for 'custom' IDE (supports {workspace} placeholder)
 */
async function openPathInIde(
  ide: string,
  targetPath: string,
  customCommand?: string | null
): Promise<boolean> {
  if (ide === 'custom') {
    if (!customCommand) {
      return false;
    }
    return await openCustomIde(customCommand, targetPath);
  }

  return await openBuiltInIde(ide, targetPath);
}

// =============================================================================
// Background Initialization
// =============================================================================

/**
 * Initialize workspace worktree in the background.
 * This function is called after the workspace record is created and allows
 * the API to return immediately while the worktree is being set up.
 */
async function initializeWorkspaceWorktree(
  workspaceId: string,
  requestedBranchName?: string
): Promise<void> {
  try {
    const workspaceWithProject = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!workspaceWithProject?.project) {
      throw new Error('Workspace project not found');
    }

    // Mark as initializing
    await workspaceAccessor.updateInitStatus(workspaceId, 'INITIALIZING');

    const project = workspaceWithProject.project;
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreeName = `workspace-${workspaceId}`;
    const baseBranch = requestedBranchName ?? project.defaultBranch;

    // Validate that the base branch exists before attempting to create worktree
    const branchExists = await gitClient.branchExists(baseBranch);
    if (!branchExists) {
      // Also check if it's a remote branch (origin/branchName)
      const remoteBranchExists = await gitClient.branchExists(`origin/${baseBranch}`);
      if (!remoteBranchExists) {
        throw new Error(
          `Branch '${baseBranch}' does not exist. Please specify an existing branch or leave empty to use the default branch '${project.defaultBranch}'.`
        );
      }
    }

    // Get the authenticated user's GitHub username for branch prefix (cached)
    if (cachedGitHubUsername === undefined) {
      cachedGitHubUsername = await githubCLIService.getAuthenticatedUsername();
    }

    const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch, {
      branchPrefix: cachedGitHubUsername ?? undefined,
      workspaceName: workspaceWithProject.name,
    });
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    // Update workspace with worktree info
    await workspaceAccessor.update(workspaceId, {
      worktreePath,
      branchName: worktreeInfo.branchName,
    });

    // Run startup script if configured
    if (startupScriptService.hasStartupScript(project)) {
      logger.info('Running startup script for workspace', {
        workspaceId,
        hasCommand: !!project.startupScriptCommand,
        hasScriptPath: !!project.startupScriptPath,
      });

      const scriptResult = await startupScriptService.runStartupScript(
        { ...workspaceWithProject, worktreePath },
        project
      );

      // If script failed, log but don't throw (workspace is still usable)
      if (!scriptResult.success) {
        const finalWorkspace = await workspaceAccessor.findById(workspaceId);
        logger.warn('Startup script failed but workspace created', {
          workspaceId,
          error: finalWorkspace?.initErrorMessage,
        });
      }
      // startup script service already updates init status
      return;
    }

    // No startup script - mark as ready
    await workspaceAccessor.updateInitStatus(workspaceId, 'READY');
  } catch (error) {
    logger.error('Failed to initialize workspace worktree', error as Error, {
      workspaceId,
    });
    // Mark workspace as failed so user can see the error and retry
    await workspaceAccessor.updateInitStatus(workspaceId, 'FAILED', (error as Error).message);
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

  // Get list of available IDEs
  getAvailableIdes: publicProcedure.query(async () => {
    const ides: Array<{ id: string; name: string }> = [];
    const settings = await userSettingsAccessor.get();

    // Check Cursor
    const cursorAvailable = await checkIdeAvailable('cursor');
    if (cursorAvailable) {
      ides.push({ id: 'cursor', name: 'Cursor' });
    }

    // Check VS Code
    const vscodeAvailable = await checkIdeAvailable('vscode');
    if (vscodeAvailable) {
      ides.push({ id: 'vscode', name: 'VS Code' });
    }

    // Add custom IDE if configured
    if (settings.preferredIde === 'custom' && settings.customIdeCommand) {
      ides.push({ id: 'custom', name: 'Custom IDE' });
    }

    return { ides, preferredIde: settings.preferredIde };
  }),

  // Open workspace in specified IDE
  openInIde: publicProcedure
    .input(z.object({ id: z.string(), ide: z.string().optional() }))
    .mutation(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.id);
      if (!workspace) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.id}`,
        });
      }

      if (!workspace.worktreePath) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Workspace has no worktree path',
        });
      }

      // Get user settings to determine which IDE to use
      const settings = await userSettingsAccessor.get();
      const ideToUse = input.ide ?? settings.preferredIde;

      // Validate custom IDE configuration
      if (ideToUse === 'custom' && !settings.customIdeCommand) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Custom IDE selected but no command configured. Please configure in Admin settings.',
        });
      }

      const opened = await openPathInIde(
        ideToUse,
        workspace.worktreePath,
        settings.customIdeCommand
      );
      if (!opened) {
        const errorMessage =
          ideToUse === 'custom'
            ? `Failed to open custom IDE. Check your command configuration in Admin settings.`
            : `Failed to open ${ideToUse}. Make sure it is installed and configured correctly.`;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: errorMessage,
        });
      }

      return { success: true };
    }),

  // Get workspace initialization status
  getInitStatus: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const workspace = await workspaceAccessor.findByIdWithProject(input.id);
    if (!workspace) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Workspace not found: ${input.id}`,
      });
    }
    return {
      initStatus: workspace.initStatus,
      initErrorMessage: workspace.initErrorMessage,
      initStartedAt: workspace.initStartedAt,
      initCompletedAt: workspace.initCompletedAt,
      hasStartupScript: !!(
        workspace.project?.startupScriptCommand || workspace.project?.startupScriptPath
      ),
    };
  }),

  // Retry failed initialization
  retryInit: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const workspace = await workspaceAccessor.findByIdWithProject(input.id);
    if (!workspace?.project) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Workspace not found: ${input.id}`,
      });
    }

    if (workspace.initStatus !== 'FAILED') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Can only retry failed initializations',
      });
    }

    if (!workspace.worktreePath) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Workspace has no worktree path',
      });
    }

    // Atomically increment retry count (max 3 retries)
    const maxRetries = 3;
    const updatedWorkspace = await workspaceAccessor.incrementRetryCount(input.id, maxRetries);
    if (!updatedWorkspace) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Maximum retry attempts (${maxRetries}) exceeded`,
      });
    }

    // Run script with the updated workspace (retry count already incremented)
    await startupScriptService.runStartupScript(
      { ...workspace, ...updatedWorkspace },
      workspace.project
    );

    return workspaceAccessor.findById(input.id);
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

  // =============================================================================
  // Git Operations
  // =============================================================================

  // Get git status for workspace
  getGitStatus: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        return { files: [], hasUncommitted: false };
      }

      const result = await gitCommand(['status', '--porcelain'], workspace.worktreePath);
      if (result.code !== 0) {
        throw new Error(`Git status failed: ${result.stderr}`);
      }

      const files = parseGitStatusOutput(result.stdout);
      return { files, hasUncommitted: files.length > 0 };
    }),

  // Get file diff for workspace (relative to project's default branch)
  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findByIdWithProject(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        throw new Error('Workspace has no worktree path');
      }

      // Validate path is safe
      if (!(await isPathSafe(workspace.worktreePath, input.filePath))) {
        throw new Error('Invalid file path');
      }

      // Get merge base with the project's default branch
      const defaultBranch = workspace.project?.defaultBranch ?? 'main';
      const mergeBase = await getMergeBase(workspace.worktreePath, defaultBranch);

      // Try to get diff from merge base (shows all changes from main)
      // Falls back to HEAD if no merge base found
      const diffBase = mergeBase ?? 'HEAD';
      let result = await gitCommand(
        ['diff', diffBase, '--', input.filePath],
        workspace.worktreePath
      );

      // If empty, try without base (for untracked files or other scenarios)
      if (result.stdout.trim() === '' && result.code === 0) {
        result = await gitCommand(['diff', '--', input.filePath], workspace.worktreePath);
      }

      // If still empty, try to show the file for new untracked files
      if (result.stdout.trim() === '' && result.code === 0) {
        // For untracked files, show the entire file as an addition
        const fullPath = path.join(workspace.worktreePath, input.filePath);
        try {
          const content = await readFile(fullPath, 'utf-8');
          // Format as a unified diff for a new file
          const lines = content.split('\n');
          const diffContent = [
            `diff --git a/${input.filePath} b/${input.filePath}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${input.filePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
          ].join('\n');
          return { diff: diffContent };
        } catch {
          // File doesn't exist or can't be read
          return { diff: '' };
        }
      }

      if (result.code !== 0) {
        throw new Error(`Git diff failed: ${result.stderr}`);
      }

      return { diff: result.stdout };
    }),

  // =============================================================================
  // File Operations
  // =============================================================================

  // List files in directory
  listFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      logger.info('listFiles called', {
        workspaceId: input.workspaceId,
        worktreePath: workspace.worktreePath,
        requestedPath: input.path,
      });

      if (!workspace.worktreePath) {
        logger.warn('No worktreePath for workspace', { workspaceId: input.workspaceId });
        return { entries: [], hasWorktree: false };
      }

      const relativePath = input.path ?? '';

      // Validate path is safe
      if (relativePath && !(await isPathSafe(workspace.worktreePath, relativePath))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(workspace.worktreePath, relativePath);

      try {
        const dirents = await readdir(fullPath, { withFileTypes: true });

        const entries: FileEntry[] = [];
        for (const dirent of dirents) {
          // Skip .git directory
          if (dirent.name === '.git') {
            continue;
          }

          // Skip hidden files starting with . (optional, could make configurable)
          // if (dirent.name.startsWith('.')) continue;

          const entryPath = relativePath ? path.join(relativePath, dirent.name) : dirent.name;
          entries.push({
            name: dirent.name,
            type: dirent.isDirectory() ? 'directory' : 'file',
            path: entryPath,
          });
        }

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        logger.info('listFiles returning entries', {
          workspaceId: input.workspaceId,
          fullPath,
          entryCount: entries.length,
        });

        return { entries, hasWorktree: true };
      } catch (error) {
        logger.error('listFiles error', error as Error, {
          workspaceId: input.workspaceId,
          fullPath,
          errorCode: (error as NodeJS.ErrnoException).code,
        });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { entries: [], hasWorktree: true };
        }
        throw error;
      }
    }),

  // Read file content
  readFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string(),
      })
    )
    .query(async ({ input }) => {
      const workspace = await workspaceAccessor.findById(input.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${input.workspaceId}`);
      }

      if (!workspace.worktreePath) {
        throw new Error('Workspace has no worktree path');
      }

      // Validate path is safe
      if (!(await isPathSafe(workspace.worktreePath, input.path))) {
        throw new Error('Invalid file path');
      }

      const fullPath = path.join(workspace.worktreePath, input.path);

      // Get file stats to check size
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        throw new Error('Path is a directory');
      }

      const fileSize = stats.size;
      const truncated = fileSize > MAX_FILE_SIZE;

      // Read file content
      const buffer = await readFile(fullPath);

      // Check if binary
      if (isBinaryContent(buffer)) {
        return {
          content: '[Binary file - cannot display]',
          language: 'text',
          truncated: false,
          size: fileSize,
          isBinary: true,
        };
      }

      // Convert to string, potentially truncated
      let content = buffer.toString('utf-8');
      if (truncated) {
        content = content.slice(0, MAX_FILE_SIZE);
      }

      return {
        content,
        language: getLanguageFromPath(input.path),
        truncated,
        size: fileSize,
        isBinary: false,
      };
    }),
});
