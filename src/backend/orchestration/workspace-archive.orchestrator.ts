import { TRPCError } from '@trpc/server';
import { githubCLIService } from '@/backend/domains/github';
import { runScriptService } from '@/backend/domains/run-script';
import { sessionService } from '@/backend/domains/session';
import { terminalService } from '@/backend/domains/terminal';
import { workspaceStateMachine, worktreeLifecycleService } from '@/backend/domains/workspace';
import { createLogger } from '@/backend/services/logger.service';
import type { WorkspaceWithProject } from './types';

const logger = createLogger('workspace-archive-orchestrator');

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
}

/**
 * Handle GitHub issue after workspace archive.
 * If there's a merged PR, add a comment referencing it.
 */
async function handleGitHubIssueOnArchive(workspace: WorkspaceWithProject): Promise<void> {
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

/**
 * Archive a workspace: validates the transition, stops all running processes,
 * cleans up the worktree, and updates the state.
 *
 * This is an orchestration function that coordinates across multiple domains
 * (workspace, session, run-script, terminal, github).
 */
export async function archiveWorkspace(
  workspace: WorkspaceWithProject,
  options: WorktreeCleanupOptions
) {
  if (!workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVED')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot archive workspace from status: ${workspace.status}`,
    });
  }

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

  const archivedWorkspace = await workspaceStateMachine.archive(workspace.id);

  // Handle associated GitHub issue after successful archive
  await handleGitHubIssueOnArchive(workspace);

  return archivedWorkspace;
}
