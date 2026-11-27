import { ApplicationError } from '@/backend/lib/application-error';
import { toError } from '@/backend/lib/error-utils';
import { sweepWorktreeProcesses } from '@/backend/lib/worktree-process-sweep';
import type { WorkspaceWithProject } from '@/backend/orchestration/types';
import { crashAt } from '@/backend/services/crash-point';
import { createLogger } from '@/backend/services/logger.service';
import type { SessionStopReason } from '@/backend/services/session';
import {
  archivedWorkspaceBlobRetentionService,
  workspaceActivityService,
  workspaceArchiveLeaseService,
  workspaceDataService,
  WorkspaceStateMachineError,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { formatArchiveIncompleteMessage } from '@/shared/workspace-archive-incomplete';
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
/** Workspaces a delete is cleaning up; archives of them are refused meanwhile. */
const archiveExclusions = new Map<string, number>();
/**
 * An ARCHIVING row this process abandoned because its status write failed.
 * `source` is null for a row taken over from elsewhere; `stamp` is the
 * `updatedAt` its lease last wrote, so the record lapses once anyone else
 * writes the row.
 */
interface InterruptedArchive {
  source: ArchiveSourceStatus | null;
  removalStarted: boolean;
  stamp: Date;
}
const interruptedArchives = new Map<string, InterruptedArchive>();

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
  /** Owned by an archive or a delete in this process, or no longer stale or claimable. */
  skipped: string[];
}

type LeftoverProcessWorktree = {
  worktreePath: string | null;
  project: { worktreeBasePath: string };
};

/**
 * Best effort: the owned cleanups above are the contract, and a failed sweep
 * leaves the same leftovers as no sweep, so it is logged and never blocks.
 */
async function terminateLeftoverWorktreeProcesses(
  workspaceId: string,
  worktree: LeftoverProcessWorktree,
  operation: 'archive' | 'delete'
): Promise<void> {
  if (!worktree.worktreePath) {
    return;
  }
  try {
    const result = await sweepWorktreeProcesses({
      worktreePath: worktree.worktreePath,
      worktreeBasePath: worktree.project.worktreeBasePath,
    });
    if (result.status === 'swept' && result.survivors.length > 0) {
      logger.warn(`Leftover worktree processes survived the sweep before ${operation}`, {
        workspaceId,
        ...result,
      });
    } else if (result.status === 'swept' && result.matched.length > 0) {
      logger.info(`Terminated leftover worktree processes before ${operation}`, {
        workspaceId,
        ...result,
      });
    }
  } catch (error) {
    logger.warn(`Leftover worktree process sweep failed before ${operation}`, {
      workspaceId,
      error: toError(error).message,
    });
  }
}

/**
 * Stops owned runtimes; any failure aborts the operation. With `worktree`, a
 * best-effort sweep then terminates leftover processes running inside it.
 */
export async function cleanupWorkspaceRuntimeResources(
  workspaceId: string,
  services: WorkspaceRuntimeCleanupDependencies,
  operation: 'archive' | 'delete',
  worktree?: LeftoverProcessWorktree
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

  if (worktree) {
    await terminateLeftoverWorktreeProcesses(workspaceId, worktree, operation);
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

/**
 * Where an archive attempt stands. Once worktree removal may have started, in
 * this attempt or an earlier one, a failure moves the workspace forward to
 * FAILED and never back to READY, and nothing snapshots the worktree again.
 */
interface ArchiveProgress {
  removalStarted: boolean;
}

async function completeArchive(
  workspace: WorkspaceWithProject,
  options: ArchiveWorkspaceOptions,
  services: ArchiveWorkspaceDependencies,
  progress: ArchiveProgress
) {
  progress.removalStarted ||=
    await worktreeLifecycleService.archiveRemovalMayHaveStarted(workspace);

  await cleanupWorkspaceRuntimeResources(workspace.id, services, 'archive', workspace);

  try {
    if (!progress.removalStarted) {
      await worktreeLifecycleService.snapshotWorkspaceWorktree(workspace, options);
    }
    progress.removalStarted = true;
    // Sandbox only: a crash here leaves the row ARCHIVING with its snapshot taken and its
    // worktree in place (e2e/sandbox/restart-archive.spec.ts).
    crashAt('archive-before-worktree-removal');
    await worktreeLifecycleService.removeWorkspaceWorktree(workspace);
  } catch (error) {
    logger.error('Failed to cleanup workspace worktree before archive', {
      workspaceId: workspace.id,
      removalStarted: progress.removalStarted,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const archivedWorkspace = await workspaceStateMachine.markArchived(workspace.id);
  // Only now, with ARCHIVED committed and terminal, drop the attachments Retry
  // needed and all but a failed setup's log tail. Best effort; never throws.
  await archivedWorkspaceBlobRetentionService.releaseAfterArchive(workspace.id);
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
  if (archiveExclusions.has(workspace.id)) {
    throw new ApplicationError('CONFLICT', 'Workspace is being deleted');
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

/**
 * Run `operation` (delete) with no archive of the workspace in this process:
 * waits for an in-flight archive to settle, however it ends, and refuses
 * archives that start while `operation` runs, so delete cleans up after an
 * archive and never alongside one.
 */
export async function withArchiveExcluded<T>(
  workspaceId: string,
  operation: () => Promise<T>
): Promise<T> {
  // A joined lock-recovery retry can start a new archive as the first settles.
  for (
    let pending = pendingArchives.get(workspaceId);
    pending;
    pending = pendingArchives.get(workspaceId)
  ) {
    try {
      await pending.result;
    } catch {
      // The archive's caller reports its failure; delete only waits for it.
    }
  }
  // Same synchronous step as the last check: no archive can register between.
  archiveExclusions.set(workspaceId, (archiveExclusions.get(workspaceId) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (archiveExclusions.get(workspaceId) ?? 1) - 1;
    if (remaining === 0) {
      archiveExclusions.delete(workspaceId);
    } else {
      archiveExclusions.set(workspaceId, remaining);
    }
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
    requestedWorkspace.status === 'ARCHIVING' || interruptedArchives.has(requestedWorkspace.id)
      ? await workspaceDataService.findByIdWithProject(requestedWorkspace.id)
      : requestedWorkspace;
  if (!workspace) {
    interruptedArchives.delete(requestedWorkspace.id);
    throw new ApplicationError('NOT_FOUND', `Workspace not found: ${requestedWorkspace.id}`);
  }
  let resume: ArchiveResume | null = null;
  if (workspace.status === 'ARCHIVING') {
    resume = await claimArchivingRow(workspace);
    if (!resume) {
      return workspace;
    }
  } else {
    interruptedArchives.delete(workspace.id);
    if (workspace.status === 'ARCHIVED') {
      return workspace;
    }
    if (!workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVING')) {
      throw new ApplicationError(
        'INVALID_INPUT',
        `Cannot archive workspace from status: ${workspace.status}`
      );
    }
  }

  return await workspaceActivityService.withNotificationsSuppressed(workspace.id, async () => {
    let statusBeforeArchive: ArchiveSourceStatus | null;
    let target = workspace;
    let stamp: Date;
    if (resume) {
      statusBeforeArchive = resume.source;
      stamp = resume.stamp;
    } else {
      try {
        const started = await workspaceStateMachine.startArchivingWithSourceStatus(workspace.id);
        statusBeforeArchive = started.previousStatus;
        stamp = started.workspace.updatedAt;
        // The caller's row may predate another attempt that marked this one incomplete.
        target = {
          ...workspace,
          status: started.previousStatus,
          initErrorMessage: started.workspace.initErrorMessage,
        };
      } catch (error) {
        return await resolveArchiveTransitionConflict(
          workspace.id,
          error,
          options,
          services,
          retryTransition
        );
      }
    }

    const lease = workspaceArchiveLeaseService.hold(workspace.id, stamp);
    const progress: ArchiveProgress = { removalStarted: resume?.removalStarted === true };
    let archived: ArchiveWorkspaceResult;
    try {
      archived = await completeArchive(target, options, services, progress);
    } catch (error) {
      const finalStamp = await lease.release();
      await settleFailedArchive(workspace.id, statusBeforeArchive, progress, error, finalStamp);
      throw error;
    }
    await lease.release();
    interruptedArchives.delete(workspace.id);
    return archived;
  });
}

/** Failure handling for this attempt, and the lease the attempt holds. */
interface ArchiveResume {
  /** The status to roll back to, or null for a row taken over from elsewhere. */
  source: ArchiveSourceStatus | null;
  removalStarted: boolean;
  stamp: Date;
}

/**
 * Claim an ARCHIVING row that no archive in this process is running (the
 * caller holds its pending entry). This process's own interrupted attempt
 * resumes at once while nobody else has written the row; any other row only
 * once its lease is stale, since another process may still be archiving it.
 * The claim is a compare-and-swap on `updatedAt`, so at most one claimer wins.
 */
async function claimArchivingRow(workspace: WorkspaceWithProject): Promise<ArchiveResume | null> {
  const interrupted = interruptedArchives.get(workspace.id);
  const own = interrupted?.stamp.getTime() === workspace.updatedAt.getTime() ? interrupted : null;
  if (interrupted && !own) {
    interruptedArchives.delete(workspace.id);
  }
  if (!(own || workspaceArchiveLeaseService.isStale(workspace.updatedAt))) {
    return null;
  }
  const stamp = await workspaceArchiveLeaseService.claim(workspace.id, workspace.updatedAt);
  if (!stamp) {
    return null;
  }
  if (!own) {
    logger.warn('Taking over an interrupted archive', {
      workspaceId: workspace.id,
      leaseWrittenAt: workspace.updatedAt.toISOString(),
    });
  }
  return { source: own?.source ?? null, removalStarted: own?.removalStarted === true, stamp };
}

/**
 * Before removal starts, roll back to the previous status. After it, move
 * forward to FAILED with the archive-incomplete marker, since the worktree may
 * be partly gone and must not be presented as ready or set up again. A row
 * taken over from elsewhere has no known previous status, so it goes to FAILED.
 */
async function settleFailedArchive(
  workspaceId: string,
  statusBeforeArchive: ArchiveSourceStatus | null,
  progress: ArchiveProgress,
  error: unknown,
  stamp: Date
): Promise<void> {
  const message = toError(error).message;
  try {
    if (progress.removalStarted) {
      await workspaceStateMachine.transition(workspaceId, 'FAILED', {
        errorMessage: formatArchiveIncompleteMessage(
          statusBeforeArchive ? message : `recovery after restart failed: ${message}`
        ),
      });
    } else if (statusBeforeArchive) {
      await workspaceStateMachine.transition(workspaceId, statusBeforeArchive);
    } else {
      await workspaceStateMachine.transition(workspaceId, 'FAILED', {
        errorMessage: `Archive recovery failed after restart: ${message}`,
      });
    }
    interruptedArchives.delete(workspaceId);
  } catch (settleError) {
    interruptedArchives.set(workspaceId, {
      source: statusBeforeArchive,
      removalStarted: progress.removalStarted,
      stamp,
    });
    logger.error('Failed to settle workspace status after archive failure', {
      workspaceId,
      settleTo: progress.removalStarted || !statusBeforeArchive ? 'FAILED' : statusBeforeArchive,
      error: toError(settleError).message,
    });
  }
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
 * Resume up to `limit` stale ARCHIVING workspaces, oldest first, through
 * `archiveWorkspace`: each is claimed before it is taken over and goes forward
 * (see `claimArchivingRow`). Rows this process is archiving or deleting are
 * skipped; their owner settles them. Stops between rows once `signal` aborts.
 */
export async function resumeStaleArchives(
  services: ArchiveWorkspaceDependencies,
  options: { limit: number; signal: AbortSignal }
): Promise<ArchiveRecoveryResult> {
  const result: ArchiveRecoveryResult = { archived: [], failed: [], skipped: [] };
  for (const id of await workspaceArchiveLeaseService.findStaleIds(options.limit)) {
    if (options.signal.aborted) {
      break;
    }
    let workspace: WorkspaceWithProject | null;
    try {
      workspace = await workspaceDataService.findByIdWithProject(id);
    } catch (error) {
      result.failed.push({ id, error: toError(error).message });
      continue;
    }
    // Checked after the read, with no await before `archiveWorkspace` registers
    // the attempt: a stop, an archive or a delete may have begun meanwhile, and
    // the row's owner may have settled it (only ARCHIVING rows are resumed).
    if (options.signal.aborted) {
      break;
    }
    if (workspace?.status !== 'ARCHIVING' || pendingArchives.has(id) || archiveExclusions.has(id)) {
      result.skipped.push(id);
      continue;
    }
    try {
      const outcome = await archiveWorkspace(workspace, {}, services);
      (outcome.status === 'ARCHIVED' ? result.archived : result.skipped).push(id);
    } catch (error) {
      result.failed.push({ id, error: toError(error).message });
    }
  }
  return result;
}
