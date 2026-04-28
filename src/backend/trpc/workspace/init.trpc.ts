import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toError } from '@/backend/lib/error-utils';
import type { WorkspaceWithProject } from '@/backend/orchestration/types';
import { initializeWorkspaceWorktree } from '@/backend/orchestration/workspace-init.orchestrator';
import { executeStartupScriptPipeline } from '@/backend/orchestration/workspace-init-script-pipeline';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import {
  getWorkspaceInitPolicy,
  workspaceDataService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { publicProcedure, router } from '@/backend/trpc/trpc';

const logger = createLogger('workspace-init-trpc');

function maxRetriesExceededError(maxRetries: number) {
  return new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: `Maximum retry attempts (${maxRetries}) exceeded`,
  });
}

async function retryFailedWorkspaceWithExistingWorktree(
  workspace: WorkspaceWithProject,
  maxRetries: number
) {
  const updatedWorkspace = await workspaceStateMachine.startProvisioning(workspace.id, {
    maxRetries,
  });
  if (!updatedWorkspace) {
    throw maxRetriesExceededError(maxRetries);
  }

  // Re-run full initialization orchestration in the background. The orchestrator
  // reuses the existing worktree, runs the full setup/startup pipeline, and
  // restores terminal/session state without blocking tRPC.
  initializeWorkspaceWorktree(workspace.id, {
    branchName: workspace.branchName ?? undefined,
    provisioningAlreadyStarted: true,
  }).catch((error) => {
    logger.error(
      'Unexpected error during background workspace initialization retry',
      toError(error),
      {
        workspaceId: workspace.id,
      }
    );
  });
}

// =============================================================================
// Router
// =============================================================================

export const workspaceInitRouter = router({
  // Get workspace initialization status
  getInitStatus: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const workspace = await workspaceDataService.findByIdWithProject(input.id);
    if (!workspace) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Workspace not found: ${input.id}`,
      });
    }

    const initPolicy = getWorkspaceInitPolicy(workspace);

    return {
      status: workspace.status,
      initErrorMessage: workspace.initErrorMessage,
      initOutput: workspace.initOutput,
      initStartedAt: workspace.initStartedAt,
      initCompletedAt: workspace.initCompletedAt,
      phase: initPolicy.phase,
      chatBanner: initPolicy.banner,
      hasStartupScript: !!(
        workspace.project?.startupScriptCommand || workspace.project?.startupScriptPath
      ),
      hasWorktreePath: !!workspace.worktreePath,
    };
  }),

  // Retry failed initialization
  retryInit: publicProcedure
    .input(z.object({ id: z.string(), useExistingBranch: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const workspace = await workspaceDataService.findByIdWithProject(input.id);
      if (!workspace?.project) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workspace not found: ${input.id}`,
        });
      }

      const isRetryableFromFailed = workspace.status === 'FAILED';
      const isRetryableFromReadyWarning =
        workspace.status === 'READY' && !!workspace.initErrorMessage;

      if (!(isRetryableFromFailed || isRetryableFromReadyWarning)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Can only retry failed or setup-warning initializations',
        });
      }

      const maxRetries = 3;

      // If worktree wasn't created (early failure), re-run full initialization
      if (!workspace.worktreePath) {
        // Reset to NEW state so initializeWorkspaceWorktree can transition properly
        const resetResult = await workspaceStateMachine.resetToNew(workspace.id, maxRetries);
        if (!resetResult) {
          throw maxRetriesExceededError(maxRetries);
        }
        const resumeMode =
          input.useExistingBranch ?? (await worktreeLifecycleService.getInitMode(workspace.id));
        if (resumeMode !== undefined) {
          await worktreeLifecycleService.setInitMode(workspace.id, resumeMode);
        }
        // Run full initialization (creates worktree + runs startup script)
        initializeWorkspaceWorktree(workspace.id, {
          branchName: workspace.branchName ?? undefined,
          useExistingBranch: resumeMode,
        }).catch((error) => {
          logger.error(
            'Unexpected error during background workspace initialization',
            toError(error),
            {
              workspaceId: workspace.id,
            }
          );
        });
        return workspaceDataService.findById(input.id);
      }

      // READY+warning: workspace is functional but setup script failed.
      // Retry by re-running the full startup script pipeline.
      if (isRetryableFromReadyWarning) {
        // Read config before state transition so a readConfig failure
        // doesn't leave the workspace stuck in PROVISIONING.
        const worktreePath = workspace.worktreePath;
        const factoryConfig = await FactoryConfigService.readConfig(worktreePath);

        const updatedWorkspace = await workspaceStateMachine.startProvisioningFromReady(
          workspace.id,
          maxRetries
        );
        if (!updatedWorkspace) {
          throw maxRetriesExceededError(maxRetries);
        }

        await executeStartupScriptPipeline({
          workspaceId: workspace.id,
          workspaceWithProject: workspace as WorkspaceWithProject,
          worktreePath,
          factoryConfig,
        });

        return workspaceDataService.findById(input.id);
      }

      await retryFailedWorkspaceWithExistingWorktree(workspace, maxRetries);

      return workspaceDataService.findById(input.id);
    }),
});
