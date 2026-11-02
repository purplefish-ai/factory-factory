import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { sessionLifecycleService } from '@/backend/services/session';
import {
  terminalService,
  terminalSessionService,
  type TerminalInstance,
} from '@/backend/services/terminal';
import {
  assertWorktreePathSafe,
  gitOpsService,
  workspaceDataService,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import type { WorkspaceWithProject } from './types';
const logger = createLogger('workspace-init-cleanup');
export type CapturedDefaultTerminal = {
  terminalId: string;
  pid: number;
  instance?: TerminalInstance;
};
type UnregisteredWorktreeCleanupCandidate = {
  project: WorkspaceWithProject['project'];
  worktreeInfo: { worktreePath: string; branchName: string };
};
async function markFailedAfterInitFailure(
  workspaceId: string,
  error: Error,
  guard?: WorkspaceInitGuard
): Promise<void> {
  try {
    await workspaceStateMachine.markFailed(
      workspaceId,
      error.message,
      ...(guard ? ([guard] as const) : [])
    );
  } catch (markFailedError) {
    // The workspace may have been deleted mid-provisioning; cleanup must still run.
    logger.warn('Failed to mark workspace FAILED after init failure', {
      workspaceId,
      error: toError(markFailedError).message,
    });
  }
}

export async function handleWorkspaceInitFailure(
  workspaceId: string,
  error: Error,
  autoCreatedTerminal?: CapturedDefaultTerminal,
  unregisteredWorktreeCleanupCandidate?: UnregisteredWorktreeCleanupCandidate,
  guard?: WorkspaceInitGuard
): Promise<void> {
  try {
    await guard?.check();
    guard?.assertCurrent();
  } catch {
    return;
  }
  logger.error('Failed to initialize workspace worktree', error, { workspaceId });
  await markFailedAfterInitFailure(workspaceId, error, guard);
  if (unregisteredWorktreeCleanupCandidate) {
    await cleanupUnregisteredWorktreeAfterInitFailure(
      workspaceId,
      unregisteredWorktreeCleanupCandidate,
      guard
    );
  }
  try {
    await guard?.check();
    guard?.assertCurrent();
  } catch {
    return;
  }
  await cleanupDefaultTerminal(workspaceId, autoCreatedTerminal, guard);
  // Guarded initialization starts providers only after READY; startup owns its own cleanup.
  if (guard) {
    return;
  }
  try {
    await sessionLifecycleService.stopWorkspaceSessions(workspaceId);
  } catch (stopError) {
    logger.warn('Failed to stop Claude sessions after init failure', {
      workspaceId,
      error: stopError instanceof Error ? stopError.message : String(stopError),
    });
  }
}

async function cleanupUnregisteredWorktreeAfterInitFailure(
  workspaceId: string,
  candidate: UnregisteredWorktreeCleanupCandidate,
  guard?: WorkspaceInitGuard
): Promise<void> {
  const { project, worktreeInfo } = candidate;

  try {
    const workspace = await workspaceDataService.findById(workspaceId);
    if (workspace?.worktreePath === worktreeInfo.worktreePath) {
      return;
    }

    if (workspace?.worktreePath) {
      logger.warn('Skipping unregistered worktree cleanup because workspace has another path', {
        workspaceId,
        createdWorktreePath: worktreeInfo.worktreePath,
        persistedWorktreePath: workspace.worktreePath,
      });
      return;
    }

    if (workspace?.status === 'PROVISIONING') {
      logger.info('Skipping unregistered worktree cleanup while workspace is provisioning', {
        workspaceId,
        worktreePath: worktreeInfo.worktreePath,
      });
      return;
    }

    await assertWorktreePathSafe(worktreeInfo.worktreePath, project.worktreeBasePath);
    await guard?.check();
    guard?.assertCurrent();
    await gitOpsService.removeWorktree(
      worktreeInfo.worktreePath,
      project,
      ...(guard ? ([guard] as const) : [])
    );
    logger.info('Removed unregistered worktree after init failure', {
      workspaceId,
      worktreePath: worktreeInfo.worktreePath,
      branchName: worktreeInfo.branchName,
    });
  } catch (cleanupError) {
    logger.warn('Failed to remove unregistered worktree after init failure', {
      workspaceId,
      worktreePath: worktreeInfo.worktreePath,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

async function cleanupDefaultTerminal(
  workspaceId: string,
  autoCreatedTerminal: CapturedDefaultTerminal | undefined,
  guard?: WorkspaceInitGuard
): Promise<void> {
  if (!autoCreatedTerminal) {
    return;
  }
  const { terminalId: autoCreatedTerminalId, pid, instance } = autoCreatedTerminal;
  try {
    if (!guard || instance) {
      terminalService.destroyTerminal(
        workspaceId,
        autoCreatedTerminalId,
        ...(instance ? [instance] : [])
      );
    }
  } catch (destroyError) {
    logger.warn('Failed to destroy default terminal after init failure', {
      workspaceId,
      terminalId: autoCreatedTerminalId,
      error: destroyError instanceof Error ? destroyError.message : String(destroyError),
    });
  }
  try {
    await guard?.check();
    guard?.assertCurrent();
    await terminalSessionService.releaseSessionPid(
      workspaceId,
      autoCreatedTerminalId,
      ...(guard ? [pid] : [])
    );
  } catch (clearPidError) {
    logger.warn('Failed to clear default terminal PID after init failure', {
      workspaceId,
      terminalId: autoCreatedTerminalId,
      error: clearPidError instanceof Error ? clearPidError.message : String(clearPidError),
    });
  }
}
