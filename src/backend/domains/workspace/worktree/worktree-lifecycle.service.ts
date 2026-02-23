import * as path from 'node:path';
import { pathExists } from '@/backend/lib/file-helpers';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { gitOpsService } from '@/backend/services/git-ops.service';

export class WorktreePathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePathSafetyError';
  }
}

export function assertWorktreePathSafe(worktreePath: string, worktreeBasePath: string): void {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedBasePath = path.resolve(worktreeBasePath);
  const basePrefix = `${resolvedBasePath}${path.sep}`;

  if (resolvedWorktreePath === resolvedBasePath || !resolvedWorktreePath.startsWith(basePrefix)) {
    throw new WorktreePathSafetyError(
      'Workspace worktree path is outside the worktree base directory'
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
    assertWorktreePathSafe(worktreePath, project.worktreeBasePath);

    const worktreeExists = await pathExists(worktreePath);
    if (!worktreeExists) {
      return;
    }

    await gitOpsService.commitIfNeeded(worktreePath, workspace.name, options.commitUncommitted);
    await gitOpsService.removeWorktree(worktreePath, project);
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
