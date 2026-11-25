import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { pathExists } from '@/backend/lib/file-helpers';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { hasArchiveIncompleteMarker } from '@/shared/workspace-archive-incomplete';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import { archiveSnapshotRef, gitOpsService } from './git-ops.service';

const logger = createLogger('worktree-lifecycle');

export class WorktreePathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePathSafetyError';
  }
}

const isErrnoCode = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException).code === code;

function assertPathWithinBase(worktreePath: string, basePath: string): void {
  const basePrefix = `${basePath}${path.sep}`;

  if (worktreePath === basePath || !worktreePath.startsWith(basePrefix)) {
    throw new WorktreePathSafetyError(
      'Workspace worktree path is outside the worktree base directory'
    );
  }
}

export async function assertWorktreePathSafe(
  worktreePath: string,
  worktreeBasePath: string
): Promise<void> {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedBasePath = path.resolve(worktreeBasePath);

  assertPathWithinBase(resolvedWorktreePath, resolvedBasePath);

  let worktreeStats: Awaited<ReturnType<typeof lstat>>;
  try {
    worktreeStats = await lstat(resolvedWorktreePath);
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  if (worktreeStats.isSymbolicLink()) {
    throw new WorktreePathSafetyError('Workspace worktree path must not be a symbolic link');
  }

  let realBasePath: string;
  let realWorktreePath: string;
  try {
    [realBasePath, realWorktreePath] = await Promise.all([
      realpath(resolvedBasePath),
      realpath(resolvedWorktreePath),
    ]);
  } catch (error) {
    throw new WorktreePathSafetyError(
      `Unable to verify workspace worktree path: ${(error as Error).message}`
    );
  }

  try {
    assertPathWithinBase(realWorktreePath, realBasePath);
  } catch {
    throw new WorktreePathSafetyError(
      'Workspace worktree real path is outside the worktree base directory'
    );
  }
}

type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;

interface WorktreeArchiveOptions {
  removeGitIndexLock?: boolean;
}

function getProjectOrThrow(workspace: WorkspaceWithProject) {
  const project = workspace.project;
  if (!(project?.repoPath && project.worktreeBasePath)) {
    throw new Error('Workspace project paths are missing');
  }
  return project;
}

class WorktreeLifecycleService {
  // DOM-04: Instance fields replace module-level globals
  private readonly initModes = new Map<string, { value: boolean; owner?: WorkspaceInitGuard }>();

  setInitMode(
    workspaceId: string,
    useExistingBranch: boolean | undefined,
    guard?: WorkspaceInitGuard
  ): Promise<void> {
    guard?.assertCurrent();
    if (useExistingBranch === undefined) {
      return Promise.resolve();
    }
    this.initModes.set(workspaceId, { value: useExistingBranch, owner: guard });
    return Promise.resolve();
  }

  async getInitMode(workspaceId: string): Promise<boolean | undefined> {
    // First check in-memory cache for current-process initialization retries.
    if (this.initModes.has(workspaceId)) {
      return this.initModes.get(workspaceId)?.value;
    }

    // Then check the database creationSource field (canonical source).
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (workspace?.creationSource === 'RESUME_BRANCH') {
      return true;
    }

    return undefined;
  }

  clearInitMode(workspaceId: string, guard?: WorkspaceInitGuard): Promise<void> {
    guard?.assertCurrent();
    if (!guard || this.initModes.get(workspaceId)?.owner === guard) {
      this.initModes.delete(workspaceId);
    }
    return Promise.resolve();
  }

  /** Returns whether the freshly read workspace should be transitioned to FAILED. */
  async prepareStaleProvisioningRecovery(workspaceId: string): Promise<boolean> {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (workspace?.status !== 'PROVISIONING') {
      return false;
    }
    if (workspace.worktreePath) {
      return true;
    }

    const project = getProjectOrThrow(workspace);
    const worktreePath = path.join(project.worktreeBasePath, `workspace-${workspaceId}`);
    await assertWorktreePathSafe(worktreePath, project.worktreeBasePath);
    await gitOpsService.removeWorktree(worktreePath, project);
    return true;
  }

  /**
   * Whether an earlier archive attempt may have started removing this
   * worktree, so its contents must not be snapshotted: either the row carries
   * the archive-incomplete marker, or an interrupted ARCHIVING row already has
   * its snapshot ref, which is written just before removal starts.
   */
  async archiveRemovalMayHaveStarted(workspace: WorkspaceWithProject): Promise<boolean> {
    if (hasArchiveIncompleteMarker(workspace.initErrorMessage)) {
      return true;
    }
    if (workspace.status !== 'ARCHIVING' || !workspace.worktreePath) {
      return false;
    }
    const project = getProjectOrThrow(workspace);
    const snapshot = await gitOpsService.readPrivateRef(
      project.repoPath,
      archiveSnapshotRef(workspace.id)
    );
    return snapshot !== null;
  }

  /** Snapshot the worktree before removal; see `gitOpsService.snapshotForArchive`. */
  async snapshotWorkspaceWorktree(
    workspace: WorkspaceWithProject,
    options: WorktreeArchiveOptions
  ): Promise<void> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      return;
    }

    const project = getProjectOrThrow(workspace);
    await assertWorktreePathSafe(worktreePath, project.worktreeBasePath);
    if (!(await pathExists(worktreePath))) {
      return;
    }

    const ref = archiveSnapshotRef(workspace.id);
    const snapshot = await gitOpsService.snapshotForArchive(worktreePath, {
      ref,
      message: `Archive workspace ${workspace.name}`,
      workspaceBranch: workspace.branchName,
      ...(options.removeGitIndexLock && { removeGitIndexLock: true }),
    });
    if (snapshot.capture !== 'none') {
      logger.info('Archive snapshot captured uncommitted changes', {
        workspaceId: workspace.id,
        ref,
        sha: snapshot.sha,
        capture: snapshot.capture,
        changes: snapshot.changes,
      });
    }
  }

  async removeWorkspaceWorktree(workspace: WorkspaceWithProject): Promise<void> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      return;
    }

    const project = getProjectOrThrow(workspace);
    await assertWorktreePathSafe(worktreePath, project.worktreeBasePath);
    await gitOpsService.removeWorktree(worktreePath, project);
  }

  /** Snapshot (unless removal may have started) then remove, for workspace deletion. */
  async cleanupWorkspaceWorktree(
    workspace: WorkspaceWithProject,
    options: WorktreeArchiveOptions
  ): Promise<void> {
    if (!(await this.archiveRemovalMayHaveStarted(workspace))) {
      await this.snapshotWorkspaceWorktree(workspace, options);
    }
    await this.removeWorkspaceWorktree(workspace);
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
