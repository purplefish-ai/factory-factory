import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { startupScriptService } from '@/backend/domains/run-script';
import {
  getWorkspaceInitPolicy,
  workspaceDataService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/domains/workspace';
import { initializeWorkspaceWorktree } from '@/backend/orchestration/workspace-init.orchestrator';
import { createLogger } from '@/backend/services/logger.service';
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
            error as Error,
            {
              workspaceId: workspace.id,
            }
          );
        });
        return workspaceDataService.findById(input.id);
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

      return workspaceDataService.findById(input.id);
    }),
});
