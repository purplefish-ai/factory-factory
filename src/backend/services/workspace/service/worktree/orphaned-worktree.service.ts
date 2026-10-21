import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { GitClientFactory } from '@/backend/clients/git.client';
import { createLogger } from '@/backend/services/logger.service';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { gitOpsService } from './git-ops.service';
import {
  canonicalPath,
  containsPath,
  isSafeWorktreeDirectory,
  protectedPathReferences,
} from './orphaned-worktree-safety';
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

type Candidate = { project: ProjectWithPaths; path: string; workspaceId: string };
type Orphan = { project: ProjectWithPaths; path: string; registered: boolean };

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

async function collectCandidates(projects: ProjectWithPaths[]): Promise<Map<string, Candidate[]>> {
  const candidates = new Map<string, Candidate[]>();

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
      const canonical = await canonicalPath(dirPath).catch((error: unknown) => {
        logger.warn('Skipping worktree whose path could not be resolved', {
          path: dirPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!canonical) {
        continue;
      }
      const owners = candidates.get(canonical) ?? [];
      owners.push({
        project,
        path: dirPath,
        workspaceId: entry.name.slice(WORKTREE_DIR_PREFIX.length),
      });
      candidates.set(canonical, owners);
    }
  }
  return candidates;
}

async function selectOrphan(
  canonical: string,
  owners: Candidate[],
  registrations: Map<string, Promise<Set<string>>>
): Promise<Orphan | undefined> {
  // Shared bases must never route a registered worktree through another
  // repository's recursive deletion fallback. Inspect every potential owner.
  let registeredOwner: Candidate | undefined;
  for (const owner of owners) {
    let paths = registrations.get(owner.project.id);
    if (!paths) {
      paths = GitClientFactory.forProject(owner.project)
        .listWorktreesWithBranches()
        .then(
          async (entries) =>
            new Set(await Promise.all(entries.map((entry) => canonicalPath(entry.path))))
        );
      registrations.set(owner.project.id, paths);
    }
    if ((await paths).has(canonical)) {
      registeredOwner ??= owner;
    }
  }
  const owner = registeredOwner ?? owners[0];
  if (owner && (await isSafeWorktreeDirectory(owner.path, Boolean(registeredOwner)))) {
    return { project: owner.project, path: owner.path, registered: Boolean(registeredOwner) };
  }
  return undefined;
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

  private async detectOrphans(): Promise<Orphan[]> {
    const projects = await projectAccessor.list();
    const candidates = await collectCandidates(projects);

    if (candidates.size === 0) {
      return [];
    }

    const activeWorkspaces = await workspaceAccessor.findNonArchivedWorktreeRefs();
    const activeIds = new Set(activeWorkspaces.map((workspace) => workspace.id));
    const protectedPaths = (
      await Promise.all([
        ...projects.flatMap((project) =>
          project.repoPath ? [protectedPathReferences(project.repoPath)] : []
        ),
        ...activeWorkspaces.flatMap((workspace) =>
          workspace.worktreePath ? [protectedPathReferences(workspace.worktreePath)] : []
        ),
      ])
    ).flat();
    const registrations = new Map<string, Promise<Set<string>>>();
    const orphans: Orphan[] = [];
    for (const [canonical, owners] of candidates) {
      if (
        owners.some((owner) => activeIds.has(owner.workspaceId)) ||
        protectedPaths.some((protectedPath) => containsPath(canonical, protectedPath))
      ) {
        continue;
      }
      try {
        const orphan = await selectOrphan(canonical, owners, registrations);
        if (orphan) {
          orphans.push(orphan);
        }
      } catch (error) {
        logger.warn('Skipping worktree whose deletion safety could not be verified', {
          path: canonical,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return orphans;
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
        if (!(await isSafeWorktreeDirectory(orphan.path, orphan.registered))) {
          throw new Error('Worktree now contains protected repository data');
        }
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
