import { ApplicationError } from '@/backend/lib/application-error';
import { createLogger } from '@/backend/services/logger.service';
import type { BranchCleanupProject } from '@/backend/services/workspace/resources/workspace-branch-cleanup.accessor';
import { resolveRepositoryIdentity } from './archived-branch-git';

/**
 * What the archived-branch and archived-ref cleanups share: the repositories
 * they may clean, and one lock so they never run at the same time (a branch
 * cleanup pins a tip just before deleting its branch, and the ref cleanup must
 * not judge that pin in between).
 */

const logger = createLogger('archived-cleanup');

export interface CleanupRepository {
  /** The repository's resolved shared Git directory. */
  identity: string;
  repoPath: string;
  /** Every project using the repository, archived or not. */
  projects: BranchCleanupProject[];
  /** The projects that are not archived; only repositories with one are cleaned. */
  activeProjects: BranchCleanupProject[];
}

export interface CleanupRepositories {
  /** Repositories at least one active project uses, by identity. */
  repositories: Map<string, CleanupRepository>;
  /** The repository of each active project. */
  repositoryByProject: Map<string, CleanupRepository>;
  /** Projects whose repository could not be identified. */
  unresolvedProjectIds: Set<string>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Group projects by repository. Repositories used only by archived projects
 * are left out, and so is a project whose repository cannot be read.
 */
export async function resolveCleanupRepositories(
  projects: BranchCleanupProject[]
): Promise<CleanupRepositories> {
  const grouped = new Map<string, { repoPath: string; projects: BranchCleanupProject[] }>();
  const unresolvedProjectIds = new Set<string>();
  for (const project of projects) {
    try {
      const identity = await resolveRepositoryIdentity(project.repoPath);
      const entry = grouped.get(identity) ?? { repoPath: project.repoPath, projects: [] };
      entry.projects.push(project);
      grouped.set(identity, entry);
    } catch (error) {
      unresolvedProjectIds.add(project.id);
      logger.warn('Skipping project whose repository could not be read', {
        projectId: project.id,
        repoPath: project.repoPath,
        error: errorMessage(error),
      });
    }
  }

  const repositories = new Map<string, CleanupRepository>();
  const repositoryByProject = new Map<string, CleanupRepository>();
  for (const [identity, entry] of grouped) {
    const activeProjects = entry.projects.filter((project) => !project.isArchived);
    const [first] = activeProjects;
    if (!first) {
      continue;
    }
    const repository = {
      identity,
      repoPath: first.repoPath,
      projects: entry.projects,
      activeProjects,
    };
    repositories.set(identity, repository);
    for (const project of activeProjects) {
      repositoryByProject.set(project.id, repository);
    }
  }
  return { repositories, repositoryByProject, unresolvedProjectIds };
}

let cleanupRunning = false;

/** Run one branch or ref cleanup at a time; a second request is refused, not queued. */
export async function runExclusiveCleanup<T>(run: () => Promise<T>): Promise<T> {
  // Set before the first await, so a concurrent call always sees it.
  if (cleanupRunning) {
    throw new ApplicationError('CONFLICT', 'A branch or snapshot cleanup is already running');
  }
  cleanupRunning = true;
  try {
    return await run();
  } finally {
    cleanupRunning = false;
  }
}
