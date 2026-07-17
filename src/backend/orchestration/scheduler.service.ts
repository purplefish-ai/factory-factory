/**
 * Scheduler Service
 *
 * Local background job scheduler for periodic tasks.
 * Replaces Inngest for PR status sync.
 */

import pLimit from 'p-limit';
import { toError } from '@/backend/lib/error-utils';
import { configService } from '@/backend/services/config.service';
import { SERVICE_INTERVAL_MS, SERVICE_THRESHOLDS } from '@/backend/services/constants';
import { githubCLIService, prFetchRegistry, prSnapshotService } from '@/backend/services/github';
import { createLogger } from '@/backend/services/logger.service';
import {
  computePRDiscoveryNextCheckAt,
  workspaceMaintenanceService,
} from '@/backend/services/workspace';

const logger = createLogger('scheduler');

// At most 3 concurrent GitHub CLI calls from the scheduler to avoid rate limit bursts
const ghLimit = pLimit(3);

type PRDiscoveryCandidate = Awaited<
  ReturnType<typeof workspaceMaintenanceService.findNeedingPRDiscovery>
>[number];

type PRDiscoveryClaim = Parameters<typeof prSnapshotService.attachDiscoveredPRAndRefresh>[2];

interface ClaimablePRDiscoveryCandidate {
  workspace: PRDiscoveryCandidate;
  branchName: string;
}

interface ClaimedPRDiscoveryCandidate extends ClaimablePRDiscoveryCandidate {
  claim: PRDiscoveryClaim;
}

interface PRDiscoveryRepositoryGroup<
  Candidate extends ClaimablePRDiscoveryCandidate = ClaimablePRDiscoveryCandidate,
> {
  owner: string;
  repo: string;
  candidates: Candidate[];
}

class SchedulerService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private syncInProgress: Promise<unknown> | null = null;

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.syncInterval) {
      return; // Already running
    }

    // Reset shutdown flag in case we're restarting
    this.isShuttingDown = false;

    this.syncInterval = setInterval(() => {
      if (this.isShuttingDown || this.syncInProgress !== null) {
        return;
      }

      this.syncInProgress = Promise.all([
        this.syncPRStatuses().catch((err) => {
          logger.error('PR sync batch failed', toError(err));
        }),
        this.discoverNewPRs().catch((err) => {
          logger.error('PR discovery batch failed', toError(err));
        }),
      ]).finally(() => {
        this.syncInProgress = null;
      });
    }, SERVICE_INTERVAL_MS.schedulerPrSync);

    logger.info('Scheduler started', { prSyncIntervalMs: SERVICE_INTERVAL_MS.schedulerPrSync });
  }

  /**
   * Stop the scheduler and wait for in-flight tasks
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    if (this.syncInProgress !== null) {
      logger.debug('Waiting for in-flight PR sync to complete');
      await this.syncInProgress;
    }

    logger.info('Scheduler stopped');
  }

  /**
   * Batch sync PR status for all workspaces with stale PR data.
   * Can also be called manually to trigger an immediate sync.
   */
  async syncPRStatuses(): Promise<{ synced: number; failed: number }> {
    if (this.isShuttingDown) {
      logger.debug('Skipping PR sync - shutdown in progress');
      return { synced: 0, failed: 0 };
    }

    const workspaces = await workspaceMaintenanceService.findNeedingPRSync(
      SERVICE_THRESHOLDS.schedulerStaleMinutes
    );

    logger.info('Starting batch PR sync', { count: workspaces.length });

    if (workspaces.length === 0) {
      return { synced: 0, failed: 0 };
    }

    const results = await Promise.all(
      workspaces.map((workspace) => ghLimit(() => this.syncSinglePR(workspace.id, workspace.prUrl)))
    );

    const synced = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logger.info('Batch PR sync completed', { synced, failed });

    return { synced, failed };
  }

  /**
   * Discover PRs for workspaces that have a branch but no PR URL yet.
   * Checks GitHub to see if a PR exists for the workspace's branch.
   */
  async discoverNewPRs(): Promise<{ discovered: number; checked: number }> {
    if (this.isShuttingDown) {
      return { discovered: 0, checked: 0 };
    }

    const checkedAt = new Date();
    const { candidateLimit, repositoryLimit } = configService.getPRDiscoveryLimits();
    const workspaces = await workspaceMaintenanceService.findNeedingPRDiscovery(
      candidateLimit,
      checkedAt
    );

    if (workspaces.length === 0) {
      return { discovered: 0, checked: 0 };
    }

    const repositoryGroups = this.groupPRDiscoveryCandidates(workspaces);
    const selectedGroups = repositoryGroups.slice(0, repositoryLimit);

    logger.info('Starting PR discovery', {
      candidates: workspaces.length,
      selectedRepositories: selectedGroups.length,
      candidateLimit,
      repositoryLimit,
      limitedRepositories: repositoryGroups.length - selectedGroups.length,
    });

    const claimedGroups = await Promise.all(
      selectedGroups.map(async (group) => {
        const claimedCandidates = await Promise.all(
          group.candidates.map(async (candidate) => {
            const { workspace, branchName } = candidate;
            const retryCount = workspace.prDiscoveryRetryCount + 1;
            const nextCheckAt = computePRDiscoveryNextCheckAt(checkedAt, retryCount);
            const claimed = await workspaceMaintenanceService.claimPRDiscoveryAttempt(
              workspace.id,
              {
                branchName,
                expectedUpdatedAt: workspace.updatedAt,
                expectedRetryCount: workspace.prDiscoveryRetryCount,
                expectedNextCheckAt: workspace.prDiscoveryNextCheckAt,
                checkedAt,
                nextCheckAt,
              }
            );
            return claimed
              ? {
                  ...candidate,
                  claim: { branchName, checkedAt, retryCount, nextCheckAt },
                }
              : null;
          })
        );

        return {
          ...group,
          candidates: claimedCandidates.filter(
            (candidate): candidate is ClaimedPRDiscoveryCandidate => candidate !== null
          ),
        };
      })
    );

    const checked = claimedGroups.reduce((sum, group) => sum + group.candidates.length, 0);

    const results = await Promise.all(
      claimedGroups
        .filter((group) => group.candidates.length > 0)
        .map((group) => ghLimit(() => this.discoverPRsForRepository(group)))
    );

    const discovered = results.reduce((sum, result) => sum + result.discovered, 0);
    const failures = results.filter((result) => result.failed).length;

    logger.info('PR discovery completed', {
      candidates: workspaces.length,
      selectedRepositories: selectedGroups.length,
      queriedRepositories: results.length,
      checked,
      discovered,
      failures,
      candidateLimit,
      repositoryLimit,
    });

    return { discovered, checked };
  }

  private async discoverPRsForRepository(
    group: PRDiscoveryRepositoryGroup<ClaimedPRDiscoveryCandidate>
  ): Promise<{ discovered: number; failed: boolean }> {
    try {
      const prs = await githubCLIService.listOpenPRs(group.owner, group.repo);
      const unmatched = new Set(group.candidates);
      let discovered = 0;

      for (const pr of [...prs].sort(
        (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
      )) {
        const prCreatedAt = new Date(pr.createdAt).getTime();
        const candidate = [...unmatched]
          .filter(
            (item) =>
              item.branchName === pr.headRefName &&
              item.workspace.createdAt.getTime() <= prCreatedAt
          )
          .sort(
            (left, right) =>
              right.workspace.createdAt.getTime() - left.workspace.createdAt.getTime()
          )[0];

        if (!candidate) {
          continue;
        }

        unmatched.delete(candidate);
        const result = await prSnapshotService.attachDiscoveredPRAndRefresh(
          candidate.workspace.id,
          pr.url,
          candidate.claim
        );
        if (result.success || result.reason === 'fetch_failed') {
          discovered += 1;
        } else {
          logger.warn('Discovered PR but failed to attach snapshot', {
            workspaceId: candidate.workspace.id,
            branchName: candidate.branchName,
            prUrl: pr.url,
            reason: result.reason,
          });
        }
      }

      return { discovered, failed: false };
    } catch (error) {
      logger.warn('PR discovery failed for repository', {
        owner: group.owner,
        repo: group.repo,
        error: error instanceof Error ? error.message : String(error),
      });
      return { discovered: 0, failed: true };
    }
  }

  private groupPRDiscoveryCandidates(
    workspaces: PRDiscoveryCandidate[]
  ): PRDiscoveryRepositoryGroup[] {
    const groups = new Map<string, PRDiscoveryRepositoryGroup>();

    for (const workspace of workspaces) {
      const { branchName, project } = workspace;
      if (!(branchName && project.githubOwner && project.githubRepo)) {
        continue;
      }

      const key = `${project.githubOwner}/${project.githubRepo}`.toLowerCase();
      const group = groups.get(key) ?? {
        owner: project.githubOwner,
        repo: project.githubRepo,
        candidates: [],
      };
      group.candidates.push({ workspace, branchName });
      groups.set(key, group);
    }

    return [...groups.values()];
  }

  /**
   * Sync PR status for a single workspace
   */
  private async syncSinglePR(
    workspaceId: string,
    prUrl: string | null
  ): Promise<{ success: boolean; reason?: string }> {
    if (this.isShuttingDown) {
      return { success: false, reason: 'shutdown' };
    }

    if (!prUrl) {
      logger.debug('Workspace has no PR URL', { workspaceId });
      return { success: false, reason: 'no_pr_url' };
    }

    if (prFetchRegistry.isRecentlyFetched(workspaceId)) {
      logger.debug('Skipping PR sync — recently fetched by another service', { workspaceId });
      return { success: true, reason: 'skipped_recent' };
    }

    // Claim the workspace synchronously before yielding to the event loop so that
    // concurrent callers see it as in-flight and skip their own redundant fetches.
    const claimToken = prFetchRegistry.startFetch(workspaceId);
    try {
      const prResult = await prSnapshotService.refreshWorkspace(workspaceId, prUrl);
      if (!prResult.success) {
        logger.warn('Failed to fetch PR status', { workspaceId, prUrl });
        prFetchRegistry.cancelFetch(workspaceId, claimToken);
        return { success: false, reason: 'fetch_failed' };
      }

      prFetchRegistry.register(workspaceId, claimToken);

      logger.debug('PR status synced', {
        workspaceId,
        prNumber: prResult.snapshot.prNumber,
        prState: prResult.snapshot.prState,
        prCiStatus: prResult.snapshot.prCiStatus,
      });

      return { success: true };
    } catch (error) {
      prFetchRegistry.cancelFetch(workspaceId, claimToken);
      logger.error('PR sync failed for workspace', toError(error), { workspaceId, prUrl });
      return { success: false, reason: 'error' };
    }
  }
}

export const schedulerService = new SchedulerService();
