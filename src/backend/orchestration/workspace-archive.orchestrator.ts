import { TRPCError } from '@trpc/server';
import { createLogger } from '@/backend/services/logger.service';
import {
  workspaceAccessor,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import type { WorkspaceWithProject } from './types';

const logger = createLogger('workspace-archive-orchestrator');

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
}

export type ArchiveWorkspaceDependencies = {
  githubCLIService: {
    addIssueComment(
      owner: string,
      repo: string,
      issueNumber: number,
      comment: string
    ): Promise<void>;
  };
  runScriptService: {
    stopRunScript(workspaceId: string): Promise<{ success: boolean; error?: string }>;
    evictWorkspaceBuffers(workspaceId: string): void;
  };
  sessionService: {
    stopWorkspaceSessions(workspaceId: string): Promise<void>;
  };
  terminalService: {
    destroyWorkspaceTerminals(workspaceId: string): void;
  };
};

export interface ArchiveRecoveryResult {
  archived: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Handle GitHub issue after workspace archive.
 * If there's a merged PR, add a comment referencing it.
 */
async function handleGitHubIssueOnArchive(
  workspace: WorkspaceWithProject,
  services: ArchiveWorkspaceDependencies
): Promise<void> {
  const { githubCLIService } = services;
  const project = workspace.project;
  if (!(workspace.githubIssueNumber && project?.githubOwner && project?.githubRepo)) {
    return;
  }

  // Only add a comment if there's a merged PR
  if (!(workspace.prState === 'MERGED' && workspace.prUrl)) {
    return;
  }

  try {
    const comment = `This workspace has been archived. The associated PR was merged: ${workspace.prUrl}`;
    await githubCLIService.addIssueComment(
      project.githubOwner,
      project.githubRepo,
      workspace.githubIssueNumber,
      comment
    );
    logger.info('Added comment to GitHub issue on workspace archive', {
      workspaceId: workspace.id,
      issueNumber: workspace.githubIssueNumber,
      prUrl: workspace.prUrl,
    });
  } catch (error) {
    // Log but don't fail the archive if comment fails
    logger.warn('Failed to add comment to GitHub issue on workspace archive', {
      workspaceId: workspace.id,
      issueNumber: workspace.githubIssueNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function completeArchive(
  workspace: WorkspaceWithProject,
  options: WorktreeCleanupOptions,
  services: ArchiveWorkspaceDependencies
) {
  const { runScriptService, sessionService, terminalService } = services;

  const cleanupResults = await Promise.allSettled([
    sessionService.stopWorkspaceSessions(workspace.id),
    (async () => {
      const result = await runScriptService.stopRunScript(workspace.id);
      if (!result.success) {
        throw new Error(result.error ?? 'Unknown run script stop failure');
      }
    })(),
    Promise.resolve().then(() => {
      terminalService.destroyWorkspaceTerminals(workspace.id);
    }),
  ]);

  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );

  if (cleanupErrors.length > 0) {
    logger.error('Failed to cleanup workspace resources before archive', {
      workspaceId: workspace.id,
      errors: cleanupErrors.map((error) =>
        error instanceof Error ? error.message : String(error)
      ),
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to cleanup workspace resources before archive',
    });
  }

  try {
    await worktreeLifecycleService.cleanupWorkspaceWorktree(workspace, options);
  } catch (error) {
    logger.error('Failed to cleanup workspace worktree before archive', {
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const archivedWorkspace = await workspaceStateMachine.markArchived(workspace.id);
  runScriptService.evictWorkspaceBuffers(workspace.id);

  // Handle associated GitHub issue after successful archive
  await handleGitHubIssueOnArchive(workspace, services);

  return archivedWorkspace;
}

/**
 * Archive a workspace: validates the transition, stops all running processes,
 * cleans up the worktree, and updates the state.
 *
 * This is an orchestration function that coordinates across multiple domains
 * (workspace, session, run-script, terminal, github).
 */
export async function archiveWorkspace(
  workspace: WorkspaceWithProject,
  options: WorktreeCleanupOptions,
  services: ArchiveWorkspaceDependencies
) {
  if (!workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVING')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot archive workspace from status: ${workspace.status}`,
    });
  }

  const { previousStatus: statusBeforeArchive } =
    await workspaceStateMachine.startArchivingWithSourceStatus(workspace.id);

  try {
    return await completeArchive(workspace, options, services);
  } catch (error) {
    try {
      await workspaceStateMachine.transition(workspace.id, statusBeforeArchive);
    } catch (rollbackError) {
      logger.error('Failed to rollback workspace status after archive failure', {
        workspaceId: workspace.id,
        rollbackTo: statusBeforeArchive,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  }
}

/**
 * Resume ARCHIVING workspaces left behind by process termination.
 * Normal archive rollback cannot run when the process exits mid-request, so
 * startup recovery either completes the archive or moves the workspace to
 * FAILED where users can see it and retry.
 */
export async function recoverStaleArchivingWorkspaces(
  services: ArchiveWorkspaceDependencies,
  options: WorktreeCleanupOptions = { commitUncommitted: true }
): Promise<ArchiveRecoveryResult> {
  const staleWorkspaces = await workspaceAccessor.findStaleArchivingWithProject();
  const result: ArchiveRecoveryResult = { archived: [], failed: [] };

  if (staleWorkspaces.length === 0) {
    return result;
  }

  logger.warn('Recovering stale archiving workspaces on startup', {
    count: staleWorkspaces.length,
    workspaceIds: staleWorkspaces.map((workspace) => workspace.id),
  });

  for (const workspace of staleWorkspaces) {
    try {
      await completeArchive(workspace, options, services);
      result.archived.push(workspace.id);
      logger.info('Recovered stale archiving workspace', { workspaceId: workspace.id });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed.push({ id: workspace.id, error: errorMessage });
      logger.error('Failed to recover stale archiving workspace', {
        workspaceId: workspace.id,
        error: errorMessage,
      });

      try {
        await workspaceStateMachine.transition(workspace.id, 'FAILED', {
          errorMessage: `Archive recovery failed after restart: ${errorMessage}`,
        });
      } catch (transitionError) {
        logger.error('Failed to mark stale archiving workspace as failed', {
          workspaceId: workspace.id,
          error:
            transitionError instanceof Error ? transitionError.message : String(transitionError),
        });
      }
    }
  }

  return result;
}
