import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { GitClientFactory } from '@/backend/clients/git.client';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceArchiveRecoveryAccessor } from '@/backend/services/workspace/resources/workspace-archive-recovery.accessor';
import { canonicalPath } from './orphaned-worktree-safety';
import { removeWorktreeRegistrationOnly } from './worktree-registration-admin';

const logger = createLogger('archived-worktree-registration');

/** Worktrees are created as `<worktreeBasePath>/workspace-<workspaceId>`. */
const WORKTREE_DIR_PREFIX = 'workspace-';

export interface ArchivedWorktreeRegistrationCleanupResult {
  removed: Array<{ projectId: string; workspaceId: string; path: string }>;
  failed: Array<{ projectId: string; path: string | null; error: string }>;
}

type RegistrationProject = { id: string; repoPath: string; worktreeBasePath: string };

interface Dependencies {
  listProjects(): Promise<RegistrationProject[]>;
  findArchivedIds(projectId: string, ids: string[]): Promise<Set<string>>;
}

type Candidate = { workspaceId: string; path: string };

async function entryExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Removes the Git registrations this app left behind for archived workspaces:
 * registered at `<canonical worktree base>/workspace-<id>` of the workspace's
 * own project, with nothing left at that path. Each goes by deleting only its
 * admin directory, as `git worktree prune` does for one entry: never a
 * repo-wide prune, since other tools register worktrees in the same
 * repositories, and never `git worktree remove`, which deletes a directory
 * that reappears at the path. A directory there is left to the admin
 * orphaned-worktree cleanup, which warns about uncommitted files.
 */
export class ArchivedWorktreeRegistrationService {
  constructor(
    private readonly dependencies: Dependencies = {
      listProjects: () => projectAccessor.listWorktreeLocations(),
      findArchivedIds: (projectId, ids) =>
        workspaceArchiveRecoveryAccessor.findArchivedIds(projectId, ids),
    }
  ) {}

  /** Removes at most `limit` registrations, stopping between them once `signal` aborts. */
  async removeLeftoverRegistrations(options: {
    limit: number;
    signal?: AbortSignal;
  }): Promise<ArchivedWorktreeRegistrationCleanupResult> {
    const result: ArchivedWorktreeRegistrationCleanupResult = { removed: [], failed: [] };
    for (const project of await this.dependencies.listProjects()) {
      if (options.signal?.aborted || result.removed.length >= options.limit) {
        break;
      }
      if (!(project.repoPath && project.worktreeBasePath)) {
        continue;
      }
      try {
        await this.cleanProject(project, result, options);
      } catch (error) {
        const message = toError(error).message;
        result.failed.push({ projectId: project.id, path: null, error: message });
        logger.warn('Skipping project during worktree registration cleanup', {
          projectId: project.id,
          error: message,
        });
      }
    }
    return result;
  }

  private async cleanProject(
    project: RegistrationProject,
    result: ArchivedWorktreeRegistrationCleanupResult,
    options: { limit: number; signal?: AbortSignal }
  ): Promise<void> {
    const gitClient = GitClientFactory.forProject(project);
    const candidates = await this.findCandidates(project, gitClient);
    if (candidates.length === 0) {
      return;
    }
    const archived = await this.dependencies.findArchivedIds(
      project.id,
      candidates.map((candidate) => candidate.workspaceId)
    );
    for (const candidate of candidates) {
      if (options.signal?.aborted || result.removed.length >= options.limit) {
        return;
      }
      if (!archived.has(candidate.workspaceId) || (await entryExists(candidate.path))) {
        continue;
      }
      try {
        const outcome = await removeWorktreeRegistrationOnly(project.repoPath, candidate.path);
        if (outcome === 'removed') {
          result.removed.push({ projectId: project.id, ...candidate });
        } else if (outcome === 'ambiguous') {
          throw new Error('More than one Git registration names this worktree path');
        }
      } catch (error) {
        result.failed.push({
          projectId: project.id,
          path: candidate.path,
          error: toError(error).message,
        });
      }
    }
  }

  /** Unlocked registrations named like ours, directly in the canonical base, with nothing on disk. */
  private async findCandidates(
    project: RegistrationProject,
    gitClient: ReturnType<typeof GitClientFactory.forProject>
  ): Promise<Candidate[]> {
    const base = await canonicalPath(project.worktreeBasePath);
    const candidates: Candidate[] = [];
    for (const entry of await gitClient.listWorktreesWithBranches()) {
      const name = path.basename(entry.path);
      if (
        entry.locked ||
        !name.startsWith(WORKTREE_DIR_PREFIX) ||
        name.length === WORKTREE_DIR_PREFIX.length ||
        (await entryExists(entry.path)) ||
        path.dirname(await canonicalPath(entry.path)) !== base
      ) {
        continue;
      }
      candidates.push({ workspaceId: name.slice(WORKTREE_DIR_PREFIX.length), path: entry.path });
    }
    return candidates;
  }
}

export const archivedWorktreeRegistrationService = new ArchivedWorktreeRegistrationService();
