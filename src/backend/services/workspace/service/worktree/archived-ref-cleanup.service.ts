import { createLogger } from '@/backend/services/logger.service';
import {
  type ArchiveRefWorkspace,
  workspaceBranchCleanupAccessor,
} from '@/backend/services/workspace/resources/workspace-branch-cleanup.accessor';
import type { WorkspaceStatus } from '@prisma-gen/client';
import {
  type CleanupRepositories,
  type CleanupRepository,
  errorMessage,
  resolveCleanupRepositories,
  runExclusiveCleanup,
} from './archived-cleanup-repositories';
import {
  type ArchivedRef,
  type ArchivedRefKind,
  countCommitsOffBranches,
  deleteArchivedRef,
  findCommitsOffBranches,
  listArchivedRefs,
  listRegisteredWorktreeNames,
  looseRefWrittenAt,
  type RefDeletionOutcome,
} from './archived-ref-git';

const logger = createLogger('archived-ref-cleanup');

/** A ref holding work found nowhere else is offered only once it is this old. */
export const UNIQUE_WORK_MIN_AGE_DAYS = 30;
const UNIQUE_WORK_MIN_AGE_MS = UNIQUE_WORK_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
/** Requests re-checked against Git together, just before their deletion. */
const REMOVAL_CHUNK = 500;

/**
 * `REDUNDANT`: the commit is reachable from a local branch or remote-tracking
 * ref, so deleting the ref loses nothing. `UNIQUE_WORK`: it is not, and the
 * ref is old enough to be offered; deleting it lets Git collect the work.
 */
export type ArchivedRefTier = 'REDUNDANT' | 'UNIQUE_WORK';

export interface ArchivedRefCandidate {
  ref: string;
  sha: string;
  kind: ArchivedRefKind;
  tier: ArchivedRefTier;
  /** For an archive ref: the workspace it is named after. */
  workspaceId: string | null;
  /** Null for a pin, or when the workspace no longer exists. */
  workspaceName: string | null;
  /** For a pin: the deleted branch. */
  branchName: string | null;
  /** Commits the ref reaches that no local branch or remote-tracking ref does. */
  unsharedCommits: number;
  /**
   * The latest of the commit date, the archived workspace's last update and
   * the loose ref file's last write: the ref is at least this old.
   */
  datedAt: Date;
}

export interface ArchivedRefCandidateGroup {
  /** The first active project using the repository; removal requests name it. */
  projectId: string;
  /** Every active project using the repository. */
  projectNames: string[];
  repoPath: string;
  refs: ArchivedRefCandidate[];
}

export interface ArchivedRefRemovalRequest {
  projectId: string;
  ref: string;
  sha: string;
  /** The tier the ref was listed in; a `REDUNDANT` request never deletes unique work. */
  tier: ArchivedRefTier;
}

export interface ArchivedRefCleanupResult {
  removed: Array<{ projectId: string; ref: string }>;
  skipped: Array<{ projectId: string; ref: string; reason: string }>;
  failed: Array<{ projectId: string; ref: string; error: string }>;
}

interface Detection extends CleanupRepositories {
  /** Candidates by repository identity, then ref name. */
  candidates: Map<string, Map<string, ArchivedRefCandidate>>;
}

interface PendingRemoval {
  request: ArchivedRefRemovalRequest;
  candidate: ArchivedRefCandidate;
}

const NOW_UNIQUE = 'Now holds work found nowhere else';

function isOldEnough(datedAt: Date, now: number): boolean {
  return now - datedAt.getTime() >= UNIQUE_WORK_MIN_AGE_MS;
}

/**
 * Why an archive ref must be kept regardless of its commits, or null. A pin
 * belongs to no workspace. An archive ref is kept while its workspace exists
 * and is not ARCHIVED (an archive in progress, or one that stopped part way and
 * still depends on the ref), and while Git still has a worktree registered
 * under the workspace's folder name.
 */
function archiveRefBlocker(
  ref: Pick<ArchivedRef, 'workspaceId'>,
  status: WorkspaceStatus | null,
  worktreeNames: Set<string>
): string | null {
  if (!ref.workspaceId) {
    return null;
  }
  if (status !== null && status !== 'ARCHIVED') {
    return 'Workspace is not archived';
  }
  if (worktreeNames.has(`workspace-${ref.workspaceId}`)) {
    return 'Workspace still has a worktree';
  }
  return null;
}

function latest(dates: Array<Date | null | undefined>): Date {
  return new Date(Math.max(...dates.map((date) => date?.getTime() ?? 0)));
}

async function detectRepositoryRefs(
  repository: CleanupRepository,
  now: number
): Promise<Map<string, ArchivedRefCandidate>> {
  const [refs, worktreeNames] = await Promise.all([
    listArchivedRefs(repository.repoPath),
    listRegisteredWorktreeNames(repository.repoPath),
  ]);
  const owners = await workspaceBranchCleanupAccessor.findArchiveRefWorkspaces(
    refs.flatMap((ref) => (ref.workspaceId ? [ref.workspaceId] : []))
  );
  const ownerOf = (ref: ArchivedRef): ArchiveRefWorkspace | undefined =>
    ref.workspaceId ? owners.get(ref.workspaceId) : undefined;
  const eligible = refs.filter(
    (ref) => !archiveRefBlocker(ref, ownerOf(ref)?.status ?? null, worktreeNames)
  );
  const offBranches = await findCommitsOffBranches(
    repository.repoPath,
    eligible.map((ref) => ref.sha)
  );

  const candidates = new Map<string, ArchivedRefCandidate>();
  for (const ref of eligible) {
    const owner = ownerOf(ref);
    const unsharedCommits = countCommitsOffBranches(ref.sha, offBranches);
    const datedAt = latest([
      ref.committedAt,
      owner?.updatedAt,
      await looseRefWrittenAt(repository.identity, ref.ref),
    ]);
    if (unsharedCommits > 0 && !isOldEnough(datedAt, now)) {
      continue;
    }
    candidates.set(ref.ref, {
      ref: ref.ref,
      sha: ref.sha,
      kind: ref.kind,
      tier: unsharedCommits === 0 ? 'REDUNDANT' : 'UNIQUE_WORK',
      workspaceId: ref.workspaceId,
      workspaceName: owner?.name ?? null,
      branchName: ref.branchName,
      unsharedCommits,
      datedAt,
    });
  }
  return candidates;
}

/** The re-detected candidate a removal request names, or why it is skipped. */
function matchListedCandidate(
  request: ArchivedRefRemovalRequest,
  detection: Detection
): { repository: CleanupRepository; candidate: ArchivedRefCandidate } | { reason: string } {
  const repository = detection.repositoryByProject.get(request.projectId);
  const candidate = repository && detection.candidates.get(repository.identity)?.get(request.ref);
  if (!(repository && candidate)) {
    return { reason: 'No longer eligible for cleanup' };
  }
  if (candidate.sha !== request.sha) {
    return { reason: 'Ref moved since it was listed' };
  }
  if (candidate.tier === 'UNIQUE_WORK' && request.tier === 'REDUNDANT') {
    return { reason: NOW_UNIQUE };
  }
  return { repository, candidate };
}

class ArchivedRefCleanupService {
  /**
   * Archive refs and deleted-branch pins that can be deleted: redundant ones,
   * and ones holding work found nowhere else once they are
   * {@link UNIQUE_WORK_MIN_AGE_DAYS} days old. See the admin settings guide.
   */
  async findCandidates(): Promise<ArchivedRefCandidateGroup[]> {
    const { repositories, candidates } = await this.detect(Date.now());
    const groups: ArchivedRefCandidateGroup[] = [];
    for (const [identity, refs] of candidates) {
      const repository = repositories.get(identity);
      const [first] = repository?.activeProjects ?? [];
      if (!(repository && first) || refs.size === 0) {
        continue;
      }
      groups.push({
        projectId: first.id,
        projectNames: repository.activeProjects.map((project) => project.name),
        repoPath: repository.repoPath,
        refs: [...refs.values()].sort(
          (a, b) => a.datedAt.getTime() - b.datedAt.getTime() || a.ref.localeCompare(b.ref)
        ),
      });
    }
    return groups;
  }

  private async detect(now: number): Promise<Detection> {
    const projects = await workspaceBranchCleanupAccessor.listProjects();
    const resolved = await resolveCleanupRepositories(projects);
    const candidates = new Map<string, Map<string, ArchivedRefCandidate>>();
    for (const [identity, repository] of resolved.repositories) {
      try {
        candidates.set(identity, await detectRepositoryRefs(repository, now));
      } catch (error) {
        logger.warn('Skipping repository whose archive refs could not be checked', {
          repoPath: repository.repoPath,
          error: errorMessage(error),
        });
      }
    }
    return { ...resolved, candidates };
  }

  /**
   * Delete the requested refs that are still candidates at the listed commit.
   * Candidates are re-detected server-side; each chunk's commits and each
   * workspace are re-checked just before deletion, and each ref is deleted
   * only while it still points at the listed commit.
   */
  removeRefs(requests: ArchivedRefRemovalRequest[]): Promise<ArchivedRefCleanupResult> {
    return runExclusiveCleanup(() => this.runCleanup(requests));
  }

  private async runCleanup(
    requests: ArchivedRefRemovalRequest[]
  ): Promise<ArchivedRefCleanupResult> {
    const result: ArchivedRefCleanupResult = { removed: [], skipped: [], failed: [] };
    const now = Date.now();
    const detection = await this.detect(now);

    const pending = new Map<CleanupRepository, PendingRemoval[]>();
    for (const request of requests) {
      const match = matchListedCandidate(request, detection);
      if ('reason' in match) {
        result.skipped.push({ projectId: request.projectId, ref: request.ref, ...match });
      } else {
        const { repository, candidate } = match;
        pending.set(repository, [...(pending.get(repository) ?? []), { request, candidate }]);
      }
    }

    for (const [repository, removals] of pending) {
      for (let start = 0; start < removals.length; start += REMOVAL_CHUNK) {
        await this.removeChunk(
          repository,
          removals.slice(start, start + REMOVAL_CHUNK),
          now,
          result
        );
      }
    }

    for (const failure of result.failed) {
      logger.warn('Failed to delete archive ref', failure);
    }
    logger.info('Archive ref cleanup finished', {
      removed: result.removed.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    });
    return result;
  }

  private async removeChunk(
    repository: CleanupRepository,
    removals: PendingRemoval[],
    now: number,
    result: ArchivedRefCleanupResult
  ): Promise<void> {
    let offBranches: Map<string, string[]>;
    let worktreeNames: Set<string>;
    try {
      [offBranches, worktreeNames] = await Promise.all([
        findCommitsOffBranches(
          repository.repoPath,
          removals.map(({ candidate }) => candidate.sha)
        ),
        listRegisteredWorktreeNames(repository.repoPath),
      ]);
    } catch (error) {
      for (const { request } of removals) {
        result.failed.push({
          projectId: request.projectId,
          ref: request.ref,
          error: errorMessage(error),
        });
      }
      return;
    }

    for (const { request, candidate } of removals) {
      const { projectId, ref } = request;
      let outcome: RefDeletionOutcome;
      try {
        outcome = await this.deleteIfStillEligible(
          repository,
          { request, candidate },
          { offBranches, worktreeNames, now }
        );
      } catch (error) {
        outcome = { status: 'failed', error: errorMessage(error) };
      }
      if (outcome.status === 'removed') {
        result.removed.push({ projectId, ref });
      } else if (outcome.status === 'skipped') {
        result.skipped.push({ projectId, ref, reason: outcome.reason });
      } else {
        result.failed.push({ projectId, ref, error: outcome.error });
      }
    }
  }

  private async deleteIfStillEligible(
    repository: CleanupRepository,
    { request, candidate }: PendingRemoval,
    fresh: { offBranches: Map<string, string[]>; worktreeNames: Set<string>; now: number }
  ): Promise<RefDeletionOutcome> {
    const holdsUniqueWork = fresh.offBranches.has(candidate.sha);
    if (
      holdsUniqueWork &&
      !(request.tier === 'UNIQUE_WORK' && isOldEnough(candidate.datedAt, fresh.now))
    ) {
      return { status: 'skipped', reason: NOW_UNIQUE };
    }
    if (candidate.workspaceId) {
      const status = await workspaceBranchCleanupAccessor.findWorkspaceStatus(
        candidate.workspaceId
      );
      const blocker = archiveRefBlocker(candidate, status, fresh.worktreeNames);
      if (blocker) {
        return { status: 'skipped', reason: blocker };
      }
    }
    return await deleteArchivedRef(repository.repoPath, candidate.ref, candidate.sha);
  }
}

export const archivedRefCleanupService = new ArchivedRefCleanupService();
