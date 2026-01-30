import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { GitClientFactory } from '../../clients/git.client';
import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import { githubCLIService } from '../../services/github-cli.service';
import { createLogger } from '../../services/logger.service';
import { startupScriptService } from '../../services/startup-script.service';
import { publicProcedure, router } from '../trpc';

const logger = createLogger('workspace-init-trpc');

// Cache the authenticated GitHub username (fetched once per server lifetime)
let cachedGitHubUsername: string | null | undefined;

// =============================================================================
// Background Initialization
// =============================================================================

/**
 * Initialize workspace worktree in the background.
 * This function is called after the workspace record is created and allows
 * the API to return immediately while the worktree is being set up.
 */
export async function initializeWorkspaceWorktree(
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

export const workspaceInitRouter = router({
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
});
