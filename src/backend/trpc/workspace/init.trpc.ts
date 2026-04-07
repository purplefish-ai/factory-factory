import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toError } from '@/backend/lib/error-utils';
import type { WorkspaceWithProject } from '@/backend/orchestration/types';
import { initializeWorkspaceWorktree } from '@/backend/orchestration/workspace-init.orchestrator';
import { executeStartupScriptPipeline } from '@/backend/orchestration/workspace-init-script-pipeline';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { createLogger } from '@/backend/services/logger.service';
import { startupScriptService } from '@/backend/services/run-script';
import {
  getWorkspaceInitPolicy,
  workspaceDataService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { publicProcedure, router } from '@/backend/trpc/trpc';

const logger = createLogger('workspace-init-trpc');

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
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: `Maximum retry attempts (${maxRetries}) exceeded`,
          });
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
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: `Maximum retry attempts (${maxRetries}) exceeded`,
          });
        }

        await executeStartupScriptPipeline({
          workspaceId: workspace.id,
          workspaceWithProject: workspace as WorkspaceWithProject,
          worktreePath,
          factoryConfig,
        });

        return workspaceDataService.findById(input.id);
      }

      // FAILED+worktree: legacy path — re-run startup script only.
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

      return workspaceDataService.findById(input.id);
    }),
});
