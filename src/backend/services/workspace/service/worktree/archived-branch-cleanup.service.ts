import { ApplicationError } from '@/backend/lib/application-error';
import { createLogger } from '@/backend/services/logger.service';
import {
  type BranchCleanupProject,
  type BranchCleanupWorkspace,
  workspaceBranchCleanupAccessor,
} from '@/backend/services/workspace/resources/workspace-branch-cleanup.accessor';
import {
  findCommitsOnRemotes,
  listBusyBranches,
  listLocalBranches,
  pinAndDeleteBranch,
  resolveRepositoryIdentity,
} from './archived-branch-git';

const logger = createLogger('archived-branch-cleanup');

/** Why a candidate's commits are safe without the local branch. */
export type ArchivedBranchSafety = 'ON_REMOTE' | 'MERGED_PR';

export interface ArchivedBranchCandidate {
  name: string;
  sha: string;
  safeBecause: ArchivedBranchSafety;
}

export interface ArchivedBranchCandidateGroup {
  /** The first active project using the repository; removal requests name it. */
  projectId: string;
  /** Every active project using the repository. */
  projectNames: string[];
  repoPath: string;
  branches: ArchivedBranchCandidate[];
}

export interface ArchivedBranchRemovalRequest {
  projectId: string;
  name: string;
  sha: string;
}

export interface ArchivedBranchCleanupResult {
  removed: Array<{ projectId: string; name: string; pinRef: string }>;
  skipped: Array<{ projectId: string; name: string; reason: string }>;
  failed: Array<{ projectId: string; name: string; error: string }>;
}

interface Repository {
  identity: string;
  repoPath: string;
  /** Every project using the repository, archived or not. */
  projects: BranchCleanupProject[];
}

/** A repository at least one active project uses; only these are cleaned. */
interface ActiveRepository extends Repository {
  activeProjects: BranchCleanupProject[];
}

interface Detection {
  repositories: Map<string, ActiveRepository>;
  repositoryByProject: Map<string, ActiveRepository>;
  /** Candidates by repository identity, then branch name. */
  candidates: Map<string, Map<string, ArchivedBranchCandidate>>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function groupRepositories(projects: BranchCleanupProject[]) {
  const repositories = new Map<string, Repository>();
  const unresolvedProjectIds = new Set<string>();
  for (const project of projects) {
    try {
      const identity = await resolveRepositoryIdentity(project.repoPath);
      const repository = repositories.get(identity) ?? {
        identity,
        repoPath: project.repoPath,
        projects: [],
      };
      repository.projects.push(project);
      repositories.set(identity, repository);
    } catch (error) {
      unresolvedProjectIds.add(project.id);
      logger.warn('Skipping project whose repository could not be read', {
        projectId: project.id,
        repoPath: project.repoPath,
        error: errorMessage(error),
      });
    }
  }
  return { repositories, unresolvedProjectIds };
}

/**
 * Branch names a repository's workspaces claim. An archived workspace owns its
 * branch only when it got as far as creating a worktree; before that its
 * `branchName` can still be the base branch it was started from.
 */
function workspaceClaims(projectIds: Set<string>, workspaces: BranchCleanupWorkspace[]) {
  const archivedOwners = new Map<string, BranchCleanupWorkspace[]>();
  const protectedNames = new Set<string>();
  for (const workspace of workspaces) {
    if (!projectIds.has(workspace.projectId)) {
      continue;
    }
    if (workspace.status !== 'ARCHIVED') {
      protectedNames.add(workspace.branchName);
    } else if (workspace.worktreePath) {
      const owners = archivedOwners.get(workspace.branchName) ?? [];
      owners.push(workspace);
      archivedOwners.set(workspace.branchName, owners);
    }
  }
  return { archivedOwners, protectedNames };
}

async function detectRepositoryCandidates(
  repository: Repository,
  workspaces: BranchCleanupWorkspace[],
  globallyProtected: Set<string>
): Promise<Map<string, ArchivedBranchCandidate>> {
  const projectIds = new Set(repository.projects.map((project) => project.id));
  const { archivedOwners, protectedNames } = workspaceClaims(projectIds, workspaces);
  const defaultBranches = new Set(repository.projects.map((project) => project.defaultBranch));
  const [branches, busy] = await Promise.all([
    listLocalBranches(repository.repoPath),
    listBusyBranches(repository.repoPath),
  ]);
  const eligible = branches.filter(
    (branch) =>
      archivedOwners.has(branch.name) &&
      !protectedNames.has(branch.name) &&
      !globallyProtected.has(branch.name) &&
      !defaultBranches.has(branch.name) &&
      !busy.has(branch.name)
  );
  const onRemotes = await findCommitsOnRemotes(
    repository.repoPath,
    eligible.map((branch) => branch.sha)
  );

  const candidates = new Map<string, ArchivedBranchCandidate>();
  for (const branch of eligible) {
    const merged = archivedOwners
      .get(branch.name)
      ?.some((owner) => owner.mergedPrHeadBranches.includes(branch.name));
    if (onRemotes.has(branch.sha)) {
      candidates.set(branch.name, { ...branch, safeBecause: 'ON_REMOTE' });
    } else if (merged) {
      candidates.set(branch.name, { ...branch, safeBecause: 'MERGED_PR' });
    }
  }
  return candidates;
}

class ArchivedBranchCleanupService {
  private cleanupRunning = false;

  /**
   * Local branches that only archived workspaces used and whose commits are
   * safe elsewhere. See {@link detectRepositoryCandidates} and the admin
   * settings guide for the full rule.
   */
  async findCandidates(): Promise<ArchivedBranchCandidateGroup[]> {
    const { repositories, candidates } = await this.detect();
    const groups: ArchivedBranchCandidateGroup[] = [];
    for (const [identity, branches] of candidates) {
      const repository = repositories.get(identity);
      const [first] = repository?.activeProjects ?? [];
      if (!(repository && first) || branches.size === 0) {
        continue;
      }
      groups.push({
        projectId: first.id,
        projectNames: repository.activeProjects.map((project) => project.name),
        repoPath: repository.repoPath,
        branches: [...branches.values()].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    return groups;
  }

  private async detect(): Promise<Detection> {
    const [projects, workspaces] = await Promise.all([
      workspaceBranchCleanupAccessor.listProjects(),
      workspaceBranchCleanupAccessor.listWorkspacesWithBranches(),
    ]);
    const { repositories: allRepositories, unresolvedProjectIds } =
      await groupRepositories(projects);
    // A workspace in a project whose repository cannot be identified could be
    // using any repository, so its branch name is protected everywhere.
    const globallyProtected = new Set(
      workspaces
        .filter((ws) => unresolvedProjectIds.has(ws.projectId) && ws.status !== 'ARCHIVED')
        .map((ws) => ws.branchName)
    );

    const repositories = new Map<string, ActiveRepository>();
    const repositoryByProject = new Map<string, ActiveRepository>();
    const candidates = new Map<string, Map<string, ArchivedBranchCandidate>>();
    for (const [identity, all] of allRepositories) {
      // Repositories used only by archived projects are left alone.
      const activeProjects = all.projects.filter((project) => !project.isArchived);
      const [first] = activeProjects;
      if (!first) {
        continue;
      }
      const repository = { ...all, repoPath: first.repoPath, activeProjects };
      repositories.set(identity, repository);
      for (const project of activeProjects) {
        repositoryByProject.set(project.id, repository);
      }
      try {
        candidates.set(
          identity,
          await detectRepositoryCandidates(repository, workspaces, globallyProtected)
        );
      } catch (error) {
        logger.warn('Skipping repository whose branches could not be checked', {
          repoPath: repository.repoPath,
          error: errorMessage(error),
        });
      }
    }
    return { repositories, repositoryByProject, candidates };
  }

  /**
   * Delete the requested branches that are still candidates at the listed
   * commit. Candidates are re-detected server-side; each branch is re-checked
   * against workspaces and worktrees immediately before its deletion.
   */
  async removeBranches(
    requests: ArchivedBranchRemovalRequest[]
  ): Promise<ArchivedBranchCleanupResult> {
    // Set before the first await, so a concurrent call always sees it.
    if (this.cleanupRunning) {
      throw new ApplicationError('CONFLICT', 'A branch cleanup is already running');
    }
    this.cleanupRunning = true;
    try {
      return await this.runCleanup(requests);
    } finally {
      this.cleanupRunning = false;
    }
  }

  private async runCleanup(
    requests: ArchivedBranchRemovalRequest[]
  ): Promise<ArchivedBranchCleanupResult> {
    const result: ArchivedBranchCleanupResult = { removed: [], skipped: [], failed: [] };
    const { repositoryByProject, candidates } = await this.detect();

    for (const request of requests) {
      const { projectId, name } = request;
      const repository = repositoryByProject.get(projectId);
      const candidate = repository && candidates.get(repository.identity)?.get(name);
      if (!(repository && candidate)) {
        result.skipped.push({ projectId, name, reason: 'No longer eligible for cleanup' });
        continue;
      }
      if (candidate.sha !== request.sha) {
        result.skipped.push({ projectId, name, reason: 'Branch moved since it was listed' });
        continue;
      }
      try {
        const outcome = await this.deleteIfStillUnclaimed(repository, candidate);
        if (outcome.status === 'removed') {
          result.removed.push({ projectId, name, pinRef: outcome.pinRef });
        } else if (outcome.status === 'skipped') {
          result.skipped.push({ projectId, name, reason: outcome.reason });
        } else {
          result.failed.push({ projectId, name, error: outcome.error });
        }
      } catch (error) {
        result.failed.push({ projectId, name, error: errorMessage(error) });
      }
    }

    for (const failure of result.failed) {
      logger.warn('Failed to delete archived branch', failure);
    }
    logger.info('Archived branch cleanup finished', {
      removed: result.removed.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    });
    return result;
  }

  private async deleteIfStillUnclaimed(repository: Repository, candidate: ArchivedBranchCandidate) {
    const projectIds = repository.projects.map((project) => project.id);
    if (
      await workspaceBranchCleanupAccessor.hasNonArchivedWorkspaceWithBranch(
        projectIds,
        candidate.name
      )
    ) {
      return { status: 'skipped', reason: 'A workspace now uses this branch' } as const;
    }
    if ((await listBusyBranches(repository.repoPath)).has(candidate.name)) {
      return { status: 'skipped', reason: 'Branch is now checked out or in use' } as const;
    }
    return pinAndDeleteBranch(repository.repoPath, candidate.name, candidate.sha);
  }
}

export const archivedBranchCleanupService = new ArchivedBranchCleanupService();
