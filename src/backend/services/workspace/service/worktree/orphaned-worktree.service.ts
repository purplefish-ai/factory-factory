import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '@/backend/services/logger.service';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { gitOpsService } from './git-ops.service';
import { assertWorktreePathSafe } from './worktree-lifecycle.service';

const logger = createLogger('orphaned-worktree-service');

/** Worktrees are created as `<worktreeBasePath>/workspace-<workspaceId>`. */
const WORKTREE_DIR_PREFIX = 'workspace-';

export interface OrphanedWorktree {
  projectId: string;
  projectName: string;
  path: string;
}

export interface OrphanedWorktreeCleanupResult {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

type ProjectWithPaths = {
  id: string;
  name: string;
  repoPath: string;
  worktreeBasePath: string;
};

/** Skip one unreadable project base so the other projects can still be cleaned. */
async function readWorktreeDirs(worktreeBasePath: string): Promise<Dirent[]> {
  try {
    return await readdir(worktreeBasePath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Skipping unreadable worktree base during orphan scan', {
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }
}

/**
 * Linked worktrees have a `.git` file and share the project's object store, so
 * their commits survive removal. A `.git` directory is a standalone repository
 * whose commits may exist nowhere else; never treat it as an orphan.
 */
async function isStandaloneRepository(dirPath: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dirPath, '.git'))).isDirectory();
  } catch {
    return false;
  }
}

class OrphanedWorktreeService {
  private cleanupInFlight: Promise<OrphanedWorktreeCleanupResult> | null = null;

  /**
   * Find worktree directories that no non-archived workspace owns, such as
   * leftovers from failed archives, deleted workspaces, or older versions.
   * Only directories following the app's `workspace-<id>` naming are considered,
   * so unrelated content in a custom worktree base is never touched.
   */
  async findOrphanedWorktrees(): Promise<OrphanedWorktree[]> {
    return (await this.detectOrphans()).map((orphan) => ({
      projectId: orphan.project.id,
      projectName: orphan.project.name,
      path: orphan.path,
    }));
  }

  private async detectOrphans(): Promise<Array<{ project: ProjectWithPaths; path: string }>> {
    const projects = await projectAccessor.list();
    const candidates: Array<{ project: ProjectWithPaths; path: string; workspaceId: string }> = [];

    // Read directories before workspaces: a workspace row always exists before
    // its worktree is created, so anything listed here that is still in use is
    // protected by the workspace query below.
    for (const project of projects) {
      if (!(project.repoPath && project.worktreeBasePath)) {
        continue;
      }
      for (const entry of await readWorktreeDirs(project.worktreeBasePath)) {
        if (!(entry.isDirectory() && entry.name.startsWith(WORKTREE_DIR_PREFIX))) {
          continue;
        }
        const dirPath = path.resolve(project.worktreeBasePath, entry.name);
        if (await isStandaloneRepository(dirPath)) {
          continue;
        }
        candidates.push({
          project,
          path: dirPath,
          workspaceId: entry.name.slice(WORKTREE_DIR_PREFIX.length),
        });
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    const activeWorkspaces = await workspaceAccessor.findNonArchivedWorktreeRefs();
    const activeIds = new Set(activeWorkspaces.map((workspace) => workspace.id));
    const activePaths = new Set(
      activeWorkspaces.flatMap((workspace) =>
        workspace.worktreePath ? [path.resolve(workspace.worktreePath)] : []
      )
    );

    return candidates
      .filter(
        (candidate) => !(activeIds.has(candidate.workspaceId) || activePaths.has(candidate.path))
      )
      .map(({ project, path: orphanPath }) => ({ project, path: orphanPath }));
  }

  /** Remove every orphaned worktree, re-detected server-side at call time. */
  removeOrphanedWorktrees(): Promise<OrphanedWorktreeCleanupResult> {
    if (!this.cleanupInFlight) {
      this.cleanupInFlight = this.runCleanup().finally(() => {
        this.cleanupInFlight = null;
      });
    }
    return this.cleanupInFlight;
  }

  private async runCleanup(): Promise<OrphanedWorktreeCleanupResult> {
    const result: OrphanedWorktreeCleanupResult = { removed: [], failed: [] };

    for (const orphan of await this.detectOrphans()) {
      try {
        await assertWorktreePathSafe(orphan.path, orphan.project.worktreeBasePath);
        await gitOpsService.removeWorktree(orphan.path, orphan.project);
        result.removed.push(orphan.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to remove orphaned worktree', { path: orphan.path, error: message });
        result.failed.push({ path: orphan.path, error: message });
      }
    }

    logger.info('Removed orphaned worktrees', {
      removed: result.removed.length,
      failed: result.failed.length,
    });
    return result;
  }
}

export const orphanedWorktreeService = new OrphanedWorktreeService();
