import { createLogger } from '@/backend/services/logger.service';
import {
  type BranchCleanupWorkspace,
  workspaceBranchCleanupAccessor,
} from '@/backend/services/workspace/resources/workspace-branch-cleanup.accessor';
import {
  findCommitsOnRemotes,
  isSameOrAncestor,
  type BranchDeletionOutcome,
  type LocalBranch,
  listBusyBranches,
  listLocalBranches,
  pinAndDeleteBranch,
  restoreDeletedBranch,
} from './archived-branch-git';
import {
  type CleanupRepositories,
  type CleanupRepository,
  errorMessage,
  resolveCleanupRepositories,
  runExclusiveCleanup,
} from './archived-cleanup-repositories';

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

interface Detection extends CleanupRepositories {
  /** Candidates by repository identity, then branch name. */
  candidates: Map<string, Map<string, ArchivedBranchCandidate>>;
  /** Every project seen; a project added later could use any repository. */
  knownProjectIds: string[];
}

/** What the per-branch re-check consults besides the repository's own projects. */
type ClaimScope = Pick<Detection, 'knownProjectIds' | 'unresolvedProjectIds'>;

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
  repository: CleanupRepository,
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
    if (onRemotes.has(branch.sha)) {
      candidates.set(branch.name, { ...branch, safeBecause: 'ON_REMOTE' });
    } else if (await mergedPrContainsTip(repository.repoPath, branch, archivedOwners)) {
      candidates.set(branch.name, { ...branch, safeBecause: 'MERGED_PR' });
    }
  }
  return candidates;
}

/**
 * A merged pull request vouches for a branch only when it was opened from a
 * branch of the same name and its last reported head contains the local tip,
 * so a commit added after the merge keeps the branch.
 */
async function mergedPrContainsTip(
  repoPath: string,
  branch: LocalBranch,
  archivedOwners: Map<string, BranchCleanupWorkspace[]>
): Promise<boolean> {
  const heads = (archivedOwners.get(branch.name) ?? []).flatMap((owner) =>
    owner.mergedPrHeads.filter((head) => head.branch === branch.name)
  );
  for (const head of heads) {
    if (await isSameOrAncestor(repoPath, branch.sha, head.sha)) {
      return true;
    }
  }
  return false;
}

class ArchivedBranchCleanupService {
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
    const resolved = await resolveCleanupRepositories(projects);
    // A workspace in a project whose repository cannot be identified could be
    // using any repository, so its branch name is protected everywhere.
    const globallyProtected = new Set(
      workspaces
        .filter((ws) => resolved.unresolvedProjectIds.has(ws.projectId) && ws.status !== 'ARCHIVED')
        .map((ws) => ws.branchName)
    );

    const candidates = new Map<string, Map<string, ArchivedBranchCandidate>>();
    for (const [identity, repository] of resolved.repositories) {
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
    return {
      ...resolved,
      candidates,
      knownProjectIds: projects.map((project) => project.id),
    };
  }

  /**
   * Delete the requested branches that are still candidates at the listed
   * commit. Candidates are re-detected server-side; each branch is re-checked
   * against workspaces and worktrees immediately before its deletion.
   */
  async removeBranches(
    requests: ArchivedBranchRemovalRequest[]
  ): Promise<ArchivedBranchCleanupResult> {
    return await runExclusiveCleanup(() => this.runCleanup(requests));
  }

  private async runCleanup(
    requests: ArchivedBranchRemovalRequest[]
  ): Promise<ArchivedBranchCleanupResult> {
    const result: ArchivedBranchCleanupResult = { removed: [], skipped: [], failed: [] };
    const detection = await this.detect();
    const { repositoryByProject, candidates } = detection;

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
        const outcome = await this.deleteIfStillUnclaimed(repository, candidate, detection);
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

  private async deleteIfStillUnclaimed(
    repository: CleanupRepository,
    candidate: ArchivedBranchCandidate,
    scope: ClaimScope
  ): Promise<BranchDeletionOutcome> {
    const claim = await claimOn(repository, candidate.name, scope);
    if (claim) {
      return { status: 'skipped', reason: claim };
    }
    const outcome = await pinAndDeleteBranch(repository.repoPath, candidate.name, candidate.sha);
    if (outcome.status !== 'removed') {
      return outcome;
    }
    // Git has no lock shared with checkouts or the app's workspace creation,
    // so check once more and put the branch back if it came into use meanwhile,
    // or if that can no longer be ruled out.
    let lateClaim: string | null;
    try {
      lateClaim = await claimOn(repository, candidate.name, scope);
    } catch (error) {
      lateClaim = `Could not re-check the branch after deleting it: ${errorMessage(error)}`;
    }
    if (!lateClaim) {
      return outcome;
    }
    if (await restoreDeletedBranch(repository.repoPath, candidate.name, candidate.sha)) {
      return { status: 'skipped', reason: `${lateClaim}; restored the branch` };
    }
    return {
      status: 'failed',
      error: `${lateClaim}, and the branch could not be restored; its commit is kept at ${outcome.pinRef}`,
    };
  }
}

/** Why a branch must not be deleted right now, or null when nothing claims it. */
async function claimOn(
  repository: CleanupRepository,
  name: string,
  scope: ClaimScope
): Promise<string | null> {
  const claimed = await workspaceBranchCleanupAccessor.hasNonArchivedWorkspaceWithBranch(name, {
    projectIds: [
      ...repository.projects.map((project) => project.id),
      ...scope.unresolvedProjectIds,
    ],
    knownProjectIds: scope.knownProjectIds,
  });
  if (claimed) {
    return 'A workspace now uses this branch';
  }
  if ((await listBusyBranches(repository.repoPath)).has(name)) {
    return 'Branch is now checked out or in use';
  }
  return null;
}

export const archivedBranchCleanupService = new ArchivedBranchCleanupService();
