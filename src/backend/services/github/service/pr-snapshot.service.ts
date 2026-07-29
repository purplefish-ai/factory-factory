import { EventEmitter } from 'node:events';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import type { GitHubPRDiscoveryClaim, GitHubWorkspaceBridge } from './bridges';
import { githubCLIService } from './github-cli.service';

const logger = createLogger('pr-snapshot');

type SnapshotData = {
  prNumber: number;
  prState: Awaited<ReturnType<typeof githubCLIService.fetchAndComputePRState>> extends infer T
    ? T extends { prState: infer S }
      ? S
      : never
    : never;
  prReviewState: string | null;
  prCiStatus: Awaited<ReturnType<typeof githubCLIService.fetchAndComputePRState>> extends infer T
    ? T extends { prCiStatus: infer S }
      ? S
      : never
    : never;
};

export type PRSnapshotRefreshResult =
  | { success: true; snapshot: SnapshotData }
  | {
      success: false;
      reason: 'workspace_not_found' | 'no_pr_url' | 'fetch_failed' | 'stale_observation' | 'error';
    };

export type AttachAndRefreshResult =
  | { success: true; snapshot: SnapshotData }
  | {
      success: false;
      reason:
        | 'workspace_not_found'
        | 'fetch_failed'
        | 'claim_stale'
        | 'stale_observation'
        | 'error';
    };

export const PR_SNAPSHOT_UPDATED = 'pr_snapshot_updated' as const;
export const PR_URL_ATTACHED = 'pr_url_attached' as const;

export interface PRSnapshotUpdatedEvent {
  workspaceId: string;
  prUrl?: string | null;
  prNumber: number;
  prState: string;
  prCiStatus: string;
  prReviewState: string | null;
  /** The PR write may have reset dispatch ownership; consumers must re-read it. */
  ratchetDispatchChanged?: true;
}

export interface PRUrlAttachedEvent {
  workspaceId: string;
  prUrl: string;
}

/** One ratchet check's observation of a PR: every input `deriveRatchetState` reads. */
interface PrObservationInput {
  prUrl: string;
  prNumber: number;
  ciStatus: SnapshotData['prCiStatus'];
  prState: SnapshotData['prState'];
  reviewState: string | null;
  /** GitHub's `mergeStateStatus == DIRTY`. */
  hasMergeConflict: boolean;
  failedAt?: Date | null;
  observedAt?: Date;
}

interface ReviewCheckInput {
  checkedAt?: Date | null;
  latestCommentId?: string;
}

interface ApplySnapshotOptions {
  eventPrUrl?: string | null;
  persistPrUrl?: string | null;
  branchName?: string;
}

class PRSnapshotService extends EventEmitter {
  private workspaceBridge: GitHubWorkspaceBridge | null = null;
  private readonly workspaceOperations = new Map<string, Promise<void>>();

  configure(bridges: { workspace: GitHubWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
  }

  private get workspace(): GitHubWorkspaceBridge {
    if (!this.workspaceBridge) {
      throw new Error(
        'PRSnapshotService not configured: workspace bridge missing. Call configure() first.'
      );
    }
    return this.workspaceBridge;
  }

  private runWorkspaceOperation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceOperations.get(workspaceId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined
    );
    this.workspaceOperations.set(workspaceId, completion);
    void completion.then(() => {
      if (this.workspaceOperations.get(workspaceId) === completion) {
        this.workspaceOperations.delete(workspaceId);
      }
    });
    return result;
  }

  /**
   * Record what a ratchet check observed about a PR. The canonical write path for
   * the ratchet's half of the PR cache.
   *
   * Publishes `PR_SNAPSHOT_UPDATED` for every applied write, exactly as the
   * PR-sync poller does. It used to publish only a dispatch-invalidation, and only
   * when a settled dispatch was reset — so a merge the ratchet saw first reached
   * the database and stopped there, leaving the client on `OPEN` and the linked
   * Linear issue uncompleted until the poller came round.
   */
  async recordPrObservation(workspaceId: string, input: PrObservationInput): Promise<void> {
    await this.runWorkspaceOperation(workspaceId, async () => {
      const result = await this.workspace.applyPrObservationWithDispatchReset(workspaceId, {
        expectedPrUrl: input.prUrl,
        expectedPrNumber: input.prNumber,
        prCiStatus: input.ciStatus,
        prState: input.prState,
        prReviewState: input.reviewState,
        prHasMergeConflict: input.hasMergeConflict,
        prUpdatedAt: input.observedAt ?? new Date(),
        ...(input.failedAt !== undefined ? { prCiFailedAt: input.failedAt ?? null } : {}),
      });
      if (!result.applied) {
        return;
      }
      // `prUrl` is deliberately absent: this observation is for the PR already
      // attached, and the PR-switch check keys off a changed url or number.
      this.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId,
        prNumber: input.prNumber,
        prState: input.prState,
        prCiStatus: input.ciStatus,
        prReviewState: input.reviewState,
        ...(result.dispatchReset ? { ratchetDispatchChanged: true as const } : {}),
      } satisfies PRSnapshotUpdatedEvent);
    });
  }

  /**
   * Record that CI failure notification was sent.
   */
  async recordCINotification(workspaceId: string, notifiedAt = new Date()): Promise<void> {
    await this.workspace.recordSnapshot(workspaceId, {
      prCiLastNotifiedAt: notifiedAt,
    });
  }

  /**
   * Record PR review polling checkpoint.
   */
  async recordReviewCheck(workspaceId: string, input: ReviewCheckInput = {}): Promise<void> {
    const checkedAt = input.checkedAt === null ? null : (input.checkedAt ?? new Date());
    await this.workspace.recordSnapshot(workspaceId, {
      prReviewLastCheckedAt: checkedAt,
      ...(input.latestCommentId !== undefined
        ? { prReviewLastCommentId: input.latestCommentId }
        : {}),
    });
  }

  /**
   * Canonical operation to attach a PR URL to a workspace and refresh its snapshot.
   * This is the single entry point for setting prUrl and PR snapshot fields.
   *
   * @param workspaceId - The workspace ID to update
   * @param prUrl - The PR URL to attach
   * @returns Result with snapshot data or failure reason
   */
  async attachAndRefreshPR(workspaceId: string, prUrl: string): Promise<AttachAndRefreshResult> {
    return await this.runWorkspaceOperation(workspaceId, () =>
      this.attachAndRefreshPRNow(workspaceId, prUrl)
    );
  }

  private async attachAndRefreshPRNow(
    workspaceId: string,
    prUrl: string
  ): Promise<AttachAndRefreshResult> {
    try {
      // Verify workspace exists
      const workspace = await this.workspace.findPRContext(workspaceId);
      if (!workspace) {
        return { success: false, reason: 'workspace_not_found' };
      }

      // Fetch PR snapshot from GitHub
      const snapshot = await githubCLIService.fetchAndComputePRState(prUrl);
      if (!snapshot) {
        // Still attach the URL even if we can't fetch details
        await this.workspace.recordSnapshot(workspaceId, {
          prUrl,
          prUpdatedAt: new Date(),
        });
        this.emit(PR_URL_ATTACHED, {
          workspaceId,
          prUrl,
        } satisfies PRUrlAttachedEvent);
        logger.warn('Attached PR URL but could not fetch snapshot', { workspaceId, prUrl });
        return { success: false, reason: 'fetch_failed' };
      }

      // Correct branchName if the PR was created on a different branch than what's stored
      const branchNameUpdate =
        snapshot.headRefName && snapshot.headRefName !== workspace.branchName
          ? { branchName: snapshot.headRefName }
          : {};

      // Write full PR snapshot atomically, including prUrl
      const applied = await this.applySnapshotNow(
        workspaceId,
        {
          prNumber: snapshot.prNumber,
          prState: snapshot.prState,
          prReviewState: snapshot.prReviewState,
          prCiStatus: snapshot.prCiStatus,
        },
        {
          persistPrUrl: prUrl,
          ...branchNameUpdate,
        }
      );
      if (!applied) {
        return { success: false, reason: 'stale_observation' };
      }

      if (branchNameUpdate.branchName) {
        logger.info('Corrected workspace branchName to match PR head branch', {
          workspaceId,
          oldBranchName: workspace.branchName,
          newBranchName: branchNameUpdate.branchName,
        });
      }

      logger.info('Attached PR and refreshed snapshot', {
        workspaceId,
        prUrl,
        prNumber: snapshot.prNumber,
        prState: snapshot.prState,
      });

      return {
        success: true,
        snapshot: {
          prNumber: snapshot.prNumber,
          prState: snapshot.prState,
          prReviewState: snapshot.prReviewState,
          prCiStatus: snapshot.prCiStatus,
        },
      };
    } catch (error) {
      logger.error('Failed to attach PR and refresh snapshot', toError(error), {
        workspaceId,
        prUrl,
      });
      return { success: false, reason: 'error' };
    }
  }

  /**
   * Attach a PR found by scheduled discovery only if the claim that selected
   * the workspace still matches. Snapshot refresh deliberately omits branch
   * correction so a later user rename cannot be overwritten.
   */
  async attachDiscoveredPRAndRefresh(
    workspaceId: string,
    prUrl: string,
    claim: GitHubPRDiscoveryClaim
  ): Promise<AttachAndRefreshResult> {
    return await this.runWorkspaceOperation(workspaceId, () =>
      this.attachDiscoveredPRAndRefreshNow(workspaceId, prUrl, claim)
    );
  }

  private async attachDiscoveredPRAndRefreshNow(
    workspaceId: string,
    prUrl: string,
    claim: GitHubPRDiscoveryClaim
  ): Promise<AttachAndRefreshResult> {
    try {
      const attached = await this.workspace.attachDiscoveredPRIfClaimMatches(
        workspaceId,
        prUrl,
        claim,
        new Date()
      );
      if (!attached) {
        return { success: false, reason: 'claim_stale' };
      }

      const snapshot = await githubCLIService.fetchAndComputePRState(prUrl);
      if (!snapshot) {
        this.emit(PR_URL_ATTACHED, {
          workspaceId,
          prUrl,
        } satisfies PRUrlAttachedEvent);
        logger.warn('Attached discovered PR URL but could not fetch snapshot', {
          workspaceId,
          prUrl,
        });
        return { success: false, reason: 'fetch_failed' };
      }

      const snapshotData: SnapshotData = {
        prNumber: snapshot.prNumber,
        prState: snapshot.prState,
        prReviewState: snapshot.prReviewState,
        prCiStatus: snapshot.prCiStatus,
      };
      const persisted = await this.workspace.updatePRSnapshotIfUrlMatches(
        workspaceId,
        prUrl,
        snapshotData,
        new Date()
      );
      if (!persisted) {
        return { success: false, reason: 'claim_stale' };
      }

      this.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId,
        prUrl,
        prNumber: snapshotData.prNumber,
        prState: snapshotData.prState,
        prCiStatus: snapshotData.prCiStatus,
        prReviewState: snapshotData.prReviewState,
      } satisfies PRSnapshotUpdatedEvent);

      return { success: true, snapshot: snapshotData };
    } catch (error) {
      logger.error('Failed to attach discovered PR and refresh snapshot', toError(error), {
        workspaceId,
        prUrl,
      });
      return { success: false, reason: 'error' };
    }
  }

  async refreshWorkspace(
    workspaceId: string,
    explicitPrUrl?: string | null
  ): Promise<PRSnapshotRefreshResult> {
    return await this.runWorkspaceOperation(workspaceId, () =>
      this.refreshWorkspaceNow(workspaceId, explicitPrUrl)
    );
  }

  private async refreshWorkspaceNow(
    workspaceId: string,
    explicitPrUrl?: string | null
  ): Promise<PRSnapshotRefreshResult> {
    try {
      let prUrl = explicitPrUrl;

      if (!prUrl) {
        const workspace = await this.workspace.findPRContext(workspaceId);
        if (!workspace) {
          return { success: false, reason: 'workspace_not_found' };
        }

        prUrl = workspace.prUrl;
      }

      if (!prUrl) {
        return { success: false, reason: 'no_pr_url' };
      }

      const snapshot = await githubCLIService.fetchAndComputePRState(prUrl);
      if (!snapshot) {
        return { success: false, reason: 'fetch_failed' };
      }

      const applied = await this.applySnapshotNow(
        workspaceId,
        {
          prNumber: snapshot.prNumber,
          prState: snapshot.prState,
          prReviewState: snapshot.prReviewState,
          prCiStatus: snapshot.prCiStatus,
        },
        {
          eventPrUrl: prUrl,
        }
      );
      if (!applied) {
        return { success: false, reason: 'stale_observation' };
      }

      return {
        success: true,
        snapshot: {
          prNumber: snapshot.prNumber,
          prState: snapshot.prState,
          prReviewState: snapshot.prReviewState,
          prCiStatus: snapshot.prCiStatus,
        },
      };
    } catch (error) {
      logger.error('Failed to refresh PR snapshot', toError(error), { workspaceId });
      return { success: false, reason: 'error' };
    }
  }

  async applySnapshot(
    workspaceId: string,
    snapshot: SnapshotData,
    options: ApplySnapshotOptions = {}
  ): Promise<void> {
    await this.runWorkspaceOperation(workspaceId, () =>
      this.applySnapshotNow(workspaceId, snapshot, options)
    );
  }

  private async applySnapshotNow(
    workspaceId: string,
    snapshot: SnapshotData,
    options: ApplySnapshotOptions = {}
  ): Promise<boolean> {
    const eventPrUrl = options.eventPrUrl ?? options.persistPrUrl;
    const result = await this.workspace.applyPrSnapshotWithDispatchReset(workspaceId, {
      ...(options.persistPrUrl !== undefined ? { prUrl: options.persistPrUrl } : {}),
      prNumber: snapshot.prNumber,
      prState: snapshot.prState,
      prReviewState: snapshot.prReviewState,
      prCiStatus: snapshot.prCiStatus,
      prUpdatedAt: new Date(),
      ...(options.branchName !== undefined ? { branchName: options.branchName } : {}),
    });
    if (!result.applied) {
      return false;
    }

    this.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId,
      ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
      prNumber: snapshot.prNumber,
      prState: snapshot.prState,
      prCiStatus: snapshot.prCiStatus,
      prReviewState: snapshot.prReviewState,
      ...(result.dispatchReset ? { ratchetDispatchChanged: true as const } : {}),
    } satisfies PRSnapshotUpdatedEvent);

    return true;
  }
}

export const prSnapshotService = new PRSnapshotService();
