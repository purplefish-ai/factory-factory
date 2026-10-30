import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toError } from '@/backend/lib/error-utils';
import type { WorkspaceWithProject } from '@/backend/orchestration/types';
import { getWorkspaceInitPolicy } from '@/backend/services/workspace';
import { type Context, publicProcedure, router, trustedLocalProcedure } from '@/backend/trpc/trpc';

const getLogger = (ctx: Context) => ctx.appContext.services.createLogger('workspace-init-trpc');

function maxRetriesExceededError(maxRetries: number) {
  return new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: `Maximum retry attempts (${maxRetries}) exceeded`,
  });
}

async function retryFailedWorkspaceWithExistingWorktree(
  ctx: Context,
  workspace: WorkspaceWithProject,
  maxRetries: number
) {
  const { initializeWorkspaceWorktree, workspaceStateMachine } = ctx.appContext.services;
  const logger = getLogger(ctx);
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

async function retryWorkspaceWithoutWorktree(
  ctx: Context,
  workspace: WorkspaceWithProject,
  useExistingBranch: boolean | undefined,
  maxRetries: number
) {
  const { initializeWorkspaceWorktree, workspaceStateMachine, worktreeLifecycleService } =
    ctx.appContext.services;
  const logger = getLogger(ctx);
  // Persist the init mode before transitioning, so a failure here cannot leave
  // the workspace restarted without an initialization queued.
  const resumeMode =
    useExistingBranch ?? (await worktreeLifecycleService.getInitMode(workspace.id));
  if (resumeMode !== undefined) {
    await worktreeLifecycleService.setInitMode(workspace.id, resumeMode);
  }
  // FAILED resets to NEW so initializeWorkspaceWorktree starts provisioning
  // itself. READY cannot return to NEW, so it starts provisioning here.
  const isFailed = workspace.status === 'FAILED';
  const restartedWorkspace = isFailed
    ? await workspaceStateMachine.resetToNew(workspace.id, maxRetries)
    : await workspaceStateMachine.startProvisioningFromReady(workspace.id, maxRetries);
  if (!restartedWorkspace) {
    throw maxRetriesExceededError(maxRetries);
  }
  // Run full initialization (creates worktree + runs startup script)
  initializeWorkspaceWorktree(workspace.id, {
    branchName: workspace.branchName ?? undefined,
    useExistingBranch: resumeMode,
    ...(!isFailed && { provisioningAlreadyStarted: true }),
  }).catch((error) => {
    logger.error('Unexpected error during background workspace initialization', toError(error), {
      workspaceId: workspace.id,
    });
  });
}

async function retryReadyWorkspaceWithWarning(
  ctx: Context,
  workspace: WorkspaceWithProject,
  worktreePath: string,
  maxRetries: number
) {
  const {
    factoryConfigService,
    workspaceStateMachine,
    executeStartupScriptPipeline,
    retryQueuedDispatchAfterWorkspaceReady,
  } = ctx.appContext.services;
  // Read config before state transition so a readConfig failure
  // doesn't leave the workspace stuck in PROVISIONING.
  const factoryConfig = await factoryConfigService.readConfig(worktreePath);

  const updatedWorkspace = await workspaceStateMachine.startProvisioningFromReady(
    workspace.id,
    maxRetries
  );
  if (!updatedWorkspace) {
    throw maxRetriesExceededError(maxRetries);
  }

  const startupScriptPipelineResult = await executeStartupScriptPipeline({
    workspaceId: workspace.id,
    workspaceWithProject: workspace,
    worktreePath,
    factoryConfig,
  });

  if (!startupScriptPipelineResult.handled) {
    await workspaceStateMachine.markReady(workspace.id);
  }

  await retryQueuedDispatchAfterWorkspaceReady(workspace.id, null);
}

// =============================================================================
// Router
// =============================================================================

export const workspaceInitRouter = router({
  // Get workspace initialization status
  getInitStatus: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const { workspaceDataService } = ctx.appContext.services;
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
  retryInit: trustedLocalProcedure
    .input(z.object({ id: z.string(), useExistingBranch: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceDataService } = ctx.appContext.services;
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
      // The init policy blocks a READY workspace whose worktree is missing and
      // offers retry, which recreates the worktree.
      const isRetryableFromReadyWithoutWorktree =
        workspace.status === 'READY' && !workspace.worktreePath;

      if (
        !(
          isRetryableFromFailed ||
          isRetryableFromReadyWarning ||
          isRetryableFromReadyWithoutWorktree
        )
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Can only retry failed, setup-warning, or missing-worktree initializations',
        });
      }

      const maxRetries = 3;

      // If worktree wasn't created (early failure) or is missing, re-run full initialization
      if (!workspace.worktreePath) {
        await retryWorkspaceWithoutWorktree(ctx, workspace, input.useExistingBranch, maxRetries);
        return workspaceDataService.findById(input.id);
      }

      // READY+warning: workspace is functional but setup script failed.
      // Retry by re-running the full startup script pipeline.
      if (isRetryableFromReadyWarning) {
        await retryReadyWorkspaceWithWarning(ctx, workspace, workspace.worktreePath, maxRetries);

        return workspaceDataService.findById(input.id);
      }

      await retryFailedWorkspaceWithExistingWorktree(ctx, workspace, maxRetries);

      return workspaceDataService.findById(input.id);
    }),
});
