import { ApplicationError } from '@/backend/lib/application-error';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionStopReason } from '@/backend/services/session';
import {
  workspaceActivityService,
  workspaceDataService,
  workspaceMaintenanceService,
  WorkspaceStateMachineError,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import type { WorkspaceWithProject } from './types';
import { fireLifecycleNotification } from './workspace-children.orchestrator';

const logger = createLogger('workspace-archive-orchestrator');

type ArchiveWorkspaceResult =
  | Awaited<ReturnType<typeof workspaceStateMachine.markArchived>>
  | WorkspaceWithProject;

interface PendingArchive {
  result: Promise<ArchiveWorkspaceResult>;
  removeGitIndexLock: boolean;
}

type ArchiveSourceStatus = Awaited<
  ReturnType<typeof workspaceStateMachine.startArchivingWithSourceStatus>
>['previousStatus'];

const pendingArchives = new Map<string, PendingArchive>();
// Only a failed rollback proves that this process abandoned an ARCHIVING row.
const interruptedArchiveSources = new Map<string, ArchiveSourceStatus>();

interface ArchiveWorkspaceOptions {
  removeGitIndexLock?: boolean;
}

export type ArchiveWorkspaceDependencies = {
  cleanupWorkspaceScopedCaches(workspaceId: string): void;
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
  sessionLifecycleService: {
    stopWorkspaceSessions(
      workspaceId: string,
      options?: { reason?: SessionStopReason }
    ): Promise<void>;
  };
  terminalService: {
    destroyWorkspaceTerminals(workspaceId: string): void;
  };
};

export type WorkspaceRuntimeCleanupDependencies = {
  runScriptService: Pick<ArchiveWorkspaceDependencies['runScriptService'], 'stopRunScript'>;
  sessionLifecycleService: ArchiveWorkspaceDependencies['sessionLifecycleService'];
  terminalService: ArchiveWorkspaceDependencies['terminalService'];
};

export interface ArchiveRecoveryResult {
  archived: string[];
  failed: Array<{ id: string; error: string }>;
}

export async function cleanupWorkspaceRuntimeResources(
  workspaceId: string,
  services: WorkspaceRuntimeCleanupDependencies,
  operation: 'archive' | 'delete'
): Promise<void> {
  const { runScriptService, sessionLifecycleService, terminalService } = services;
  const sessionStopReason = operation === 'archive' ? 'WORKSPACE_ARCHIVED' : 'SYSTEM_STOP';

  // Stopping sessions must not announce completion while worktree cleanup is pending.
  workspaceActivityService.clearWorkspace(workspaceId);

  const cleanupResults = await Promise.allSettled([
    sessionLifecycleService.stopWorkspaceSessions(workspaceId, {
      reason: sessionStopReason,
    }),
    (async () => {
      const result = await runScriptService.stopRunScript(workspaceId);
      if (!result.success) {
        throw new Error(result.error ?? 'Unknown run script stop failure');
      }
    })(),
    Promise.resolve().then(() => {
      terminalService.destroyWorkspaceTerminals(workspaceId);
    }),
  ]);

  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );

  if (cleanupErrors.length > 0) {
    logger.error(`Failed to cleanup workspace resources before ${operation}`, {
      workspaceId,
      errors: cleanupErrors.map((error) =>
        error instanceof Error ? error.message : String(error)
      ),
    });
    const message = `Failed to cleanup workspace resources before ${operation}`;
    throw new ApplicationError('INTERNAL_ERROR', message, {
      cause:
        cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, message),
    });
  }
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
  const merged = workspace.prs.filter((pr) => pr.state === 'MERGED');
  if (!merged.length) {
    return;
  }

  try {
    const comment = `This workspace has been archived. The associated PR was merged: ${merged.map((pr) => pr.url).join(', ')}`;
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
  options: ArchiveWorkspaceOptions,
  services: ArchiveWorkspaceDependencies
) {
  await cleanupWorkspaceRuntimeResources(workspace.id, services, 'archive');

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
  services.cleanupWorkspaceScopedCaches(workspace.id);
  services.runScriptService.evictWorkspaceBuffers(workspace.id);

  // Notify parent workspace that this child was archived (fire-and-forget)
  fireLifecycleNotification(
    workspace.id,
    `Child workspace "${workspace.name}" has been archived.`
  ).catch((err: unknown) =>
    logger.warn('Failed to send archive lifecycle notification', {
      workspaceId: workspace.id,
      error: err,
    })
  );

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
  options: ArchiveWorkspaceOptions,
  services: ArchiveWorkspaceDependencies
) {
  // Single and bulk callers share the result, including real cleanup failures.
  const pending = pendingArchives.get(workspace.id);
  if (pending) {
    return await joinPendingArchive(pending, workspace, options, services);
  }

  const operation = performArchive(workspace, options, services);
  pendingArchives.set(workspace.id, {
    result: operation,
    removeGitIndexLock: options.removeGitIndexLock === true,
  });
  try {
    return await operation;
  } finally {
    pendingArchives.delete(workspace.id);
  }
}

async function joinPendingArchive(
  pending: PendingArchive,
  workspace: WorkspaceWithProject,
  options: ArchiveWorkspaceOptions,
  services: ArchiveWorkspaceDependencies
): Promise<ArchiveWorkspaceResult> {
  try {
    return await pending.result;
  } catch (error) {
    if (
      options.removeGitIndexLock &&
      !pending.removeGitIndexLock &&
      error instanceof ApplicationError &&
      error.kind === 'GIT_INDEX_LOCKED'
    ) {
      // The owner releases its pending entry before joined callers resume.
      // Honor explicit lock recovery after the ordinary archive has stopped.
      return await archiveWorkspace(workspace, options, services);
    }
    throw error;
  }
}

async function performArchive(
  requestedWorkspace: WorkspaceWithProject,
  options: ArchiveWorkspaceOptions,
  services: ArchiveWorkspaceDependencies,
  retryTransition = true
): Promise<ArchiveWorkspaceResult> {
  // The previous owner may have rolled back since the router read ARCHIVING.
  const workspace =
    requestedWorkspace.status === 'ARCHIVING' ||
    interruptedArchiveSources.has(requestedWorkspace.id)
      ? await workspaceDataService.findByIdWithProject(requestedWorkspace.id)
      : requestedWorkspace;
  if (!workspace) {
    interruptedArchiveSources.delete(requestedWorkspace.id);
    throw new ApplicationError('NOT_FOUND', `Workspace not found: ${requestedWorkspace.id}`);
  }
  const resumeSource = await getArchiveResumeSource(workspace);
  if (workspace.status === 'ARCHIVED' || (workspace.status === 'ARCHIVING' && !resumeSource)) {
    return workspace;
  }

  if (!(resumeSource || workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVING'))) {
    throw new ApplicationError(
      'INVALID_INPUT',
      `Cannot archive workspace from status: ${workspace.status}`
    );
  }

  return await workspaceActivityService.withNotificationsSuppressed(workspace.id, async () => {
    let statusBeforeArchive: ArchiveSourceStatus;
    try {
      statusBeforeArchive =
        resumeSource ??
        (await workspaceStateMachine.startArchivingWithSourceStatus(workspace.id)).previousStatus;
    } catch (error) {
      return await resolveArchiveTransitionConflict(
        workspace.id,
        error,
        options,
        services,
        retryTransition
      );
    }

    try {
      const archived = await completeArchive(workspace, options, services);
      interruptedArchiveSources.delete(workspace.id);
      return archived;
    } catch (error) {
      try {
        await workspaceStateMachine.transition(workspace.id, statusBeforeArchive);
        interruptedArchiveSources.delete(workspace.id);
      } catch (rollbackError) {
        interruptedArchiveSources.set(workspace.id, statusBeforeArchive);
        logger.error('Failed to rollback workspace status after archive failure', {
          workspaceId: workspace.id,
          rollbackTo: statusBeforeArchive,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    }
  });
}

async function getArchiveResumeSource(
  workspace: WorkspaceWithProject
): Promise<ArchiveSourceStatus | undefined> {
  if (workspace.status !== 'ARCHIVING') {
    interruptedArchiveSources.delete(workspace.id);
    return undefined;
  }
  const source = interruptedArchiveSources.get(workspace.id);
  if (source) {
    return source;
  }
  // Reuse startup recovery's age threshold before taking over an unknown owner.
  const stale = await workspaceMaintenanceService.findStaleArchiving();
  return stale.some((candidate) => candidate.id === workspace.id) ? 'FAILED' : undefined;
}

async function resolveArchiveTransitionConflict(
  workspaceId: string,
  error: unknown,
  options: ArchiveWorkspaceOptions,
  services: ArchiveWorkspaceDependencies,
  retryTransition: boolean
): Promise<ArchiveWorkspaceResult> {
  // A queued bulk item can become archived after its router read, or lose
  // the conditional transition to an archive owned by another process.
  if (error instanceof WorkspaceStateMachineError) {
    const current = await workspaceDataService.findByIdWithProject(workspaceId);
    if (
      current &&
      (current.status === 'ARCHIVING' ||
        current.status === 'ARCHIVED' ||
        (retryTransition && (current.status === 'READY' || current.status === 'FAILED')))
    ) {
      return await performArchive(current, options, services, false);
    }
  }
  throw error;
}

/**
 * Resume ARCHIVING workspaces left behind by process termination.
 * Normal archive rollback cannot run when the process exits mid-request, so
 * startup recovery either completes the archive or moves the workspace to
 * FAILED where users can see it and retry.
 */
export async function recoverStaleArchivingWorkspaces(
  services: ArchiveWorkspaceDependencies,
  options: ArchiveWorkspaceOptions = {}
): Promise<ArchiveRecoveryResult> {
  const staleWorkspaces = await workspaceMaintenanceService.findStaleArchiving();
  const result: ArchiveRecoveryResult = { archived: [], failed: [] };

  if (staleWorkspaces.length === 0) {
    return result;
  }

  logger.warn('Recovering stale archiving workspaces on startup', {
    count: staleWorkspaces.length,
    workspaceIds: staleWorkspaces.map((workspace) => workspace.id),
  });

  for (const workspace of staleWorkspaces) {
    await workspaceActivityService.withNotificationsSuppressed(workspace.id, async () => {
      try {
        await completeArchive(workspace, options, services);
        result.archived.push(workspace.id);
        logger.info('Recovered stale archiving workspace', { workspaceId: workspace.id });
      } catch (error) {
        const errorMessage = toError(error).message;
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
            error: toError(transitionError).message,
          });
        }
      }
    });
  }

  return result;
}
