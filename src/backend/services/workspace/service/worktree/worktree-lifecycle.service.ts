import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { pathExists } from '@/backend/lib/file-helpers';
import { gitOpsService } from '@/backend/services/git-ops.service';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';

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

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
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
  private readonly initModes = new Map<string, boolean>();

  setInitMode(workspaceId: string, useExistingBranch: boolean | undefined): Promise<void> {
    if (useExistingBranch === undefined) {
      return Promise.resolve();
    }
    this.initModes.set(workspaceId, useExistingBranch);
    return Promise.resolve();
  }

  async getInitMode(workspaceId: string): Promise<boolean | undefined> {
    // First check in-memory cache for current-process initialization retries.
    if (this.initModes.has(workspaceId)) {
      return this.initModes.get(workspaceId);
    }

    // Then check the database creationSource field (canonical source).
    const workspace = await workspaceAccessor.findById(workspaceId);
    if (workspace?.creationSource === 'RESUME_BRANCH') {
      return true;
    }

    return undefined;
  }

  clearInitMode(workspaceId: string): Promise<void> {
    this.initModes.delete(workspaceId);
    return Promise.resolve();
  }

  async cleanupWorkspaceWorktree(
    workspace: WorkspaceWithProject,
    options: WorktreeCleanupOptions
  ): Promise<void> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      return;
    }

    const project = getProjectOrThrow(workspace);
    await assertWorktreePathSafe(worktreePath, project.worktreeBasePath);

    const worktreeExists = await pathExists(worktreePath);
    if (!worktreeExists) {
      return;
    }

    await gitOpsService.commitIfNeeded(worktreePath, workspace.name, options.commitUncommitted);
    await gitOpsService.removeWorktree(worktreePath, project);
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
