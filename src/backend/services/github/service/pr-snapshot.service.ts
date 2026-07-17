import { EventEmitter } from 'node:events';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { type PRDiscoveryClaim, workspaceAccessor } from '@/backend/services/workspace';
import type { GitHubKanbanBridge } from './bridges';
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
  | { success: false; reason: 'workspace_not_found' | 'no_pr_url' | 'fetch_failed' | 'error' };

export type AttachAndRefreshResult =
  | { success: true; snapshot: SnapshotData }
  | {
      success: false;
      reason: 'workspace_not_found' | 'fetch_failed' | 'claim_stale' | 'error';
    };

export const PR_SNAPSHOT_UPDATED = 'pr_snapshot_updated' as const;
export const PR_DISPATCH_INVALIDATED = 'pr_dispatch_invalidated' as const;

export interface PRDispatchInvalidatedEvent {
  workspaceId: string;
}

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

interface CIObservationInput {
  ciStatus: SnapshotData['prCiStatus'];
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
  private kanbanBridge: GitHubKanbanBridge | null = null;

  configure(bridges: { kanban: GitHubKanbanBridge }): void {
    this.kanbanBridge = bridges.kanban;
  }

  private get kanban(): GitHubKanbanBridge {
    if (!this.kanbanBridge) {
      throw new Error(
        'PRSnapshotService not configured: kanban bridge missing. Call configure() first.'
      );
    }
    return this.kanbanBridge;
  }

  /**
   * Record CI status observation for a workspace.
   * This is the canonical write path for CI tracking fields.
   */
  async recordCIObservation(workspaceId: string, input: CIObservationInput): Promise<void> {
    const dispatchReset = await workspaceAccessor.applyCIObservationWithDispatchReset(workspaceId, {
      prCiStatus: input.ciStatus,
      prUpdatedAt: input.observedAt ?? new Date(),
      ...(input.failedAt !== undefined ? { prCiFailedAt: input.failedAt ?? null } : {}),
    });
    if (dispatchReset) {
      this.emit(PR_DISPATCH_INVALIDATED, { workspaceId } satisfies PRDispatchInvalidatedEvent);
    }
    await this.kanban.updateCachedKanbanColumn(workspaceId);
  }

  /**
   * Record that CI failure notification was sent.
   */
  async recordCINotification(workspaceId: string, notifiedAt = new Date()): Promise<void> {
    await workspaceAccessor.update(workspaceId, {
      prCiLastNotifiedAt: notifiedAt,
    });
  }

  /**
   * Record PR review polling checkpoint.
   */
  async recordReviewCheck(workspaceId: string, input: ReviewCheckInput = {}): Promise<void> {
    const checkedAt = input.checkedAt === null ? null : (input.checkedAt ?? new Date());
    await workspaceAccessor.update(workspaceId, {
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
    try {
      // Verify workspace exists
      const workspace = await workspaceAccessor.findById(workspaceId);
      if (!workspace) {
        return { success: false, reason: 'workspace_not_found' };
      }

      // Fetch PR snapshot from GitHub
      const snapshot = await githubCLIService.fetchAndComputePRState(prUrl);
      if (!snapshot) {
        // Still attach the URL even if we can't fetch details
        await workspaceAccessor.update(workspaceId, {
          prUrl,
          prUpdatedAt: new Date(),
        });
        await this.kanban.updateCachedKanbanColumn(workspaceId);
        logger.warn('Attached PR URL but could not fetch snapshot', { workspaceId, prUrl });
        return { success: false, reason: 'fetch_failed' };
      }

      // Correct branchName if the PR was created on a different branch than what's stored
      const branchNameUpdate =
        snapshot.headRefName && snapshot.headRefName !== workspace.branchName
          ? { branchName: snapshot.headRefName }
          : {};

      // Write full PR snapshot atomically, including prUrl
      await this.applySnapshot(
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
    claim: PRDiscoveryClaim
  ): Promise<AttachAndRefreshResult> {
    try {
      const attached = await workspaceAccessor.attachDiscoveredPRIfClaimMatches(
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
        await this.kanban.updateCachedKanbanColumn(workspaceId);
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
      const persisted = await workspaceAccessor.updatePRSnapshotIfUrlMatches(
        workspaceId,
        prUrl,
        snapshotData,
        new Date()
      );
      if (!persisted) {
        return { success: false, reason: 'claim_stale' };
      }

      await this.kanban.updateCachedKanbanColumn(workspaceId);
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
    try {
      let prUrl = explicitPrUrl;

      if (!prUrl) {
        const workspace = await workspaceAccessor.findById(workspaceId);
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

      await this.applySnapshot(
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
    const eventPrUrl = options.eventPrUrl ?? options.persistPrUrl;
    const dispatchReset = await workspaceAccessor.applyPrSnapshotWithDispatchReset(workspaceId, {
      ...(options.persistPrUrl !== undefined ? { prUrl: options.persistPrUrl } : {}),
      prNumber: snapshot.prNumber,
      prState: snapshot.prState,
      prReviewState: snapshot.prReviewState,
      prCiStatus: snapshot.prCiStatus,
      prUpdatedAt: new Date(),
      ...(options.branchName !== undefined ? { branchName: options.branchName } : {}),
    });

    await this.kanban.updateCachedKanbanColumn(workspaceId);

    this.emit(PR_SNAPSHOT_UPDATED, {
      workspaceId,
      ...(eventPrUrl !== undefined ? { prUrl: eventPrUrl } : {}),
      prNumber: snapshot.prNumber,
      prState: snapshot.prState,
      prCiStatus: snapshot.prCiStatus,
      prReviewState: snapshot.prReviewState,
      ...(dispatchReset ? { ratchetDispatchChanged: true as const } : {}),
    } satisfies PRSnapshotUpdatedEvent);
  }
}

export const prSnapshotService = new PRSnapshotService();
