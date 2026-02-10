import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createLogger } from '../../services/logger.service';
import { startupScriptService } from '../../services/startup-script.service';
import { workspaceDataService } from '../../services/workspace-data.service';
import { getWorkspaceInitPolicy } from '../../services/workspace-init-policy.service';
import { workspaceStateMachine } from '../../services/workspace-state-machine.service';
import {
  getWorkspaceInitMode,
  setWorkspaceInitMode,
  worktreeLifecycleService,
} from '../../services/worktree-lifecycle.service';
import { publicProcedure, router } from '../trpc';

const logger = createLogger('workspace-init-trpc');
// =============================================================================
// Background Initialization
// =============================================================================

/**
 * Initialize workspace worktree in the background.
 * This function is called after the workspace record is created and allows
 * the API to return immediately while the worktree is being set up.
 */
export function initializeWorkspaceWorktree(
  workspaceId: string,
  options?: { branchName?: string; useExistingBranch?: boolean }
): Promise<void> {
  return worktreeLifecycleService.initializeWorkspaceWorktree(workspaceId, options);
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
          input.useExistingBranch ??
          (await getWorkspaceInitMode(workspace.id, workspace.project.worktreeBasePath));
        if (resumeMode !== undefined) {
          await setWorkspaceInitMode(workspace.id, resumeMode, workspace.project.worktreeBasePath);
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
