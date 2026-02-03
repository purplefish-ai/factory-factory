import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { GitClientFactory } from '../../clients/git.client';
import { workspaceAccessor } from '../../resource_accessors/workspace.accessor';
import { FactoryConfigService } from '../../services/factory-config.service';
import { githubCLIService } from '../../services/github-cli.service';
import { createLogger } from '../../services/logger.service';
import { startupScriptService } from '../../services/startup-script.service';
import { workspaceStateMachine } from '../../services/workspace-state-machine.service';
import { publicProcedure, router } from '../trpc';

const logger = createLogger('workspace-init-trpc');

// Cache the authenticated GitHub username (fetched once per server lifetime)
let cachedGitHubUsername: string | null | undefined;

type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;

async function startProvisioningOrLog(workspaceId: string): Promise<boolean> {
  try {
    await workspaceStateMachine.startProvisioning(workspaceId);
    return true;
  } catch (error) {
    // If we can't start provisioning (e.g., workspace deleted), log and return
    logger.error('Failed to start provisioning', error as Error, { workspaceId });
    return false;
  }
}

async function getWorkspaceWithProjectOrThrow(workspaceId: string): Promise<WorkspaceWithProject> {
  const workspaceWithProject = await workspaceAccessor.findByIdWithProject(workspaceId);
  if (!workspaceWithProject?.project) {
    throw new Error('Workspace project not found');
  }
  return workspaceWithProject;
}

async function ensureBaseBranchExists(
  gitClient: ReturnType<typeof GitClientFactory.forProject>,
  baseBranch: string,
  defaultBranch: string
): Promise<void> {
  const branchExists = await gitClient.branchExists(baseBranch);
  if (branchExists) {
    return;
  }

  // Also check if it's a remote branch (origin/branchName)
  const remoteBranchExists = await gitClient.branchExists(`origin/${baseBranch}`);
  if (!remoteBranchExists) {
    throw new Error(
      `Branch '${baseBranch}' does not exist. Please specify an existing branch or leave empty to use the default branch '${defaultBranch}'.`
    );
  }
}

async function getCachedGitHubUsername(): Promise<string | null> {
  if (cachedGitHubUsername === undefined) {
    cachedGitHubUsername = await githubCLIService.getAuthenticatedUsername();
  }
  return cachedGitHubUsername ?? null;
}

async function readFactoryConfigSafe(
  worktreePath: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof FactoryConfigService.readConfig>>> {
  try {
    const factoryConfig = await FactoryConfigService.readConfig(worktreePath);
    if (factoryConfig) {
      logger.info('Found factory-factory.json config', {
        workspaceId,
        hasSetup: !!factoryConfig.scripts.setup,
        hasRun: !!factoryConfig.scripts.run,
        hasCleanup: !!factoryConfig.scripts.cleanup,
      });
    }
    return factoryConfig;
  } catch (error) {
    logger.error('Failed to parse factory-factory.json', error as Error, {
      workspaceId,
    });
    // Continue without factory config if parsing fails
    return null;
  }
}

async function runFactorySetupScriptIfConfigured(
  workspaceId: string,
  workspaceWithProject: WorkspaceWithProject,
  worktreePath: string,
  factoryConfig: Awaited<ReturnType<typeof FactoryConfigService.readConfig>>
): Promise<boolean> {
  if (!factoryConfig?.scripts.setup) {
    return false;
  }

  logger.info('Running setup script from factory-factory.json', { workspaceId });

  const scriptResult = await startupScriptService.runStartupScript(
    { ...workspaceWithProject, worktreePath },
    {
      ...workspaceWithProject.project,
      startupScriptCommand: factoryConfig.scripts.setup,
      startupScriptPath: null,
    }
  );

  // If script failed, log but don't throw (workspace is still usable)
  if (!scriptResult.success) {
    const finalWorkspace = await workspaceAccessor.findById(workspaceId);
    logger.warn('Setup script from factory-factory.json failed but workspace created', {
      workspaceId,
      error: finalWorkspace?.initErrorMessage,
    });
  }
  // startup script service already updates init status
  return true;
}

async function runProjectStartupScriptIfConfigured(
  workspaceId: string,
  workspaceWithProject: WorkspaceWithProject,
  worktreePath: string
): Promise<boolean> {
  const project = workspaceWithProject.project;
  if (!startupScriptService.hasStartupScript(project)) {
    return false;
  }

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
  return true;
}

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
  // Transition to PROVISIONING state first, before any validation.
  // This ensures that any error during initialization can be properly surfaced
  // via markFailed() since PROVISIONING -> FAILED is a valid transition.
  const startedProvisioning = await startProvisioningOrLog(workspaceId);
  if (!startedProvisioning) {
    return;
  }

  try {
    const workspaceWithProject = await getWorkspaceWithProjectOrThrow(workspaceId);
    const project = workspaceWithProject.project;
    const gitClient = GitClientFactory.forProject({
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });

    const worktreeName = `workspace-${workspaceId}`;
    const baseBranch = requestedBranchName ?? project.defaultBranch;

    // Validate that the base branch exists before attempting to create worktree
    await ensureBaseBranchExists(gitClient, baseBranch, project.defaultBranch);

    // Get the authenticated user's GitHub username for branch prefix (cached)
    const gitHubUsername = await getCachedGitHubUsername();

    const worktreeInfo = await gitClient.createWorktree(worktreeName, baseBranch, {
      branchPrefix: gitHubUsername ?? undefined,
      workspaceName: workspaceWithProject.name,
    });
    const worktreePath = gitClient.getWorktreePath(worktreeName);

    // Read factory-factory.json configuration from the worktree
    const factoryConfig = await readFactoryConfigSafe(worktreePath, workspaceId);

    // Update workspace with worktree info and run script from factory-factory.json
    await workspaceAccessor.update(workspaceId, {
      worktreePath,
      branchName: worktreeInfo.branchName,
      runScriptCommand: factoryConfig?.scripts.run ?? null,
      runScriptCleanupCommand: factoryConfig?.scripts.cleanup ?? null,
    });

    // Run setup script from factory-factory.json if configured
    const ranFactorySetup = await runFactorySetupScriptIfConfigured(
      workspaceId,
      workspaceWithProject,
      worktreePath,
      factoryConfig
    );
    if (ranFactorySetup) {
      return;
    }

    // Fallback to project-level startup script if configured
    const ranProjectSetup = await runProjectStartupScriptIfConfigured(
      workspaceId,
      workspaceWithProject,
      worktreePath
    );
    if (ranProjectSetup) {
      return;
    }

    // No startup script - mark as ready
    await workspaceStateMachine.markReady(workspaceId);
  } catch (error) {
    logger.error('Failed to initialize workspace worktree', error as Error, {
      workspaceId,
    });
    // Mark workspace as failed so user can see the error and retry
    await workspaceStateMachine.markFailed(workspaceId, (error as Error).message);
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
      // Return status field - frontend maps NEW/PROVISIONING/FAILED to show overlay
      status: workspace.status,
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

    if (workspace.status !== 'FAILED') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Can only retry failed initializations',
      });
    }

    const maxRetries = 3;

    // If worktree wasn't created (early failure), re-run full initialization
    if (!workspace.worktreePath) {
      // Reset to NEW state so initializeWorkspaceWorktree can transition properly
      const resetResult = await workspaceStateMachine.resetToNew(workspace.id, maxRetries);
      if (!resetResult) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Maximum retry attempts (${maxRetries}) exceeded`,
        });
      }
      // Run full initialization (creates worktree + runs startup script)
      initializeWorkspaceWorktree(workspace.id, workspace.branchName ?? undefined);
      return workspaceAccessor.findById(input.id);
    }

    // Worktree exists - just retry the startup script
    const updatedWorkspace = await workspaceStateMachine.startProvisioning(input.id, {
      maxRetries,
    });
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
