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
        | 'no_pr_url'
        | 'stale_observation'
        | 'error';
    };

export const PR_SNAPSHOT_UPDATED = 'pr_snapshot_updated' as const;
export const PR_URL_ATTACHED = 'pr_url_attached' as const;
export const PR_DETACHED = 'pr_detached' as const;

export interface PRSnapshotUpdatedEvent {
  prId?: string;
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
  prId?: string;
  workspaceId: string;
  prUrl: string;
}

/** One ratchet check's observation of a PR: every input `deriveRatchetState` reads. */
interface PrObservationInput {
  prId?: string;
  expectedRevision?: number;
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
  prId?: string;
  checkedAt?: Date | null;
  latestCommentId?: string;
}

interface ApplySnapshotOptions {
  prId?: string;
  expectedRevision?: number;
  eventPrUrl?: string | null;
  persistPrUrl?: string | null;
  branchName?: string;
}

class PRSnapshotService extends EventEmitter {
  private workspaceBridge: GitHubWorkspaceBridge | null = null;
  private observe:
    | ((
        target: { workspaceId: string; prId: string },
        options?: { force?: boolean }
      ) => Promise<boolean>)
    | null = null;
  configure(bridges: {
    workspace: GitHubWorkspaceBridge;
    observe?: (
      target: { workspaceId: string; prId: string },
      options?: { force?: boolean }
    ) => Promise<boolean>;
  }): void {
    this.workspaceBridge = bridges.workspace;
    this.observe = bridges.observe ?? null;
  }
  private get workspace(): GitHubWorkspaceBridge {
    if (!this.workspaceBridge) {
      throw new Error(
        'PRSnapshotService not configured: workspace bridge missing. Call configure() first.'
      );
    }
    return this.workspaceBridge;
  }
  async attachAndRefreshPR(workspaceId: string, prUrl: string): Promise<AttachAndRefreshResult> {
    try {
      if (!(await this.workspace.findPRContext(workspaceId))) {
        return { success: false, reason: 'workspace_not_found' };
      }
      const attached = await this.workspace.attachPR(workspaceId, prUrl);
      if (attached.created || attached.reattached) {
        this.emit(PR_URL_ATTACHED, {
          workspaceId,
          prId: attached.prId,
          prUrl,
        } satisfies PRUrlAttachedEvent);
      }
      return await this.refreshPR({ workspaceId, prId: attached.prId });
    } catch (error) {
      logger.error('Failed to attach PR', toError(error), { workspaceId, prUrl });
      return { success: false, reason: 'error' };
    }
  }
  async detachPR(target: { workspaceId: string; prId: string }): Promise<boolean> {
    const removed = await this.workspace.detachPR(target);
    if (removed) {
      this.emit(PR_DETACHED, target);
    }
    return removed;
  }
  async refreshPR(target: { workspaceId: string; prId: string }): Promise<PRSnapshotRefreshResult> {
    try {
      const pr = await this.workspace.findPR(target);
      if (!pr) {
        return { success: false, reason: 'no_pr_url' };
      }
      if (this.observe) {
        if (!(await this.observe(target, { force: true }))) {
          return { success: false, reason: 'stale_observation' };
        }
        const current = await this.workspace.findPR(target);
        if (!current?.number) {
          return { success: false, reason: 'no_pr_url' };
        }
        return {
          success: true,
          snapshot: {
            prNumber: current.number,
            prState: current.state,
            prCiStatus: current.ciStatus,
            prReviewState: current.reviewState,
          },
        };
      }
      const snapshot = await githubCLIService.fetchAndComputePRState(pr.url);
      if (!snapshot) {
        return { success: false, reason: 'fetch_failed' };
      }
      const result = await this.workspace.applyPrSnapshotWithDispatchReset(target.workspaceId, {
        ...snapshot,
        prId: pr.id,
        expectedRevision: pr.revision,
        prUpdatedAt: new Date(),
      });
      if (!result.applied) {
        return { success: false, reason: 'stale_observation' };
      }
      this.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId: target.workspaceId,
        prId: pr.id,
        prUrl: pr.url,
        ...snapshot,
        ...(result.dispatchReset ? { ratchetDispatchChanged: true as const } : {}),
      } satisfies PRSnapshotUpdatedEvent);
      return { success: true, snapshot };
    } catch (error) {
      logger.error('Failed to refresh PR', toError(error), target);
      return { success: false, reason: 'error' };
    }
  }
  async refreshWorkspace(
    workspaceId: string,
    explicitPrUrl?: string | null
  ): Promise<PRSnapshotRefreshResult> {
    const prs = (await this.workspace.listPRs(workspaceId)).filter(
      (pr) => !explicitPrUrl || pr.url === explicitPrUrl
    );
    if (!prs.length) {
      return { success: false, reason: 'no_pr_url' };
    }
    let result: PRSnapshotRefreshResult = { success: false, reason: 'no_pr_url' };
    let failed: PRSnapshotRefreshResult | undefined;
    for (const pr of prs) {
      result = await this.refreshPR({ workspaceId, prId: pr.id });
      if (!result.success) {
        failed = result;
      }
    }
    return failed ?? result;
  }
  async attachDiscoveredPRAndRefresh(
    workspaceId: string,
    prUrl: string,
    claim: GitHubPRDiscoveryClaim
  ): Promise<AttachAndRefreshResult> {
    const ids = await this.workspace.attachDiscoveredPRsIfClaimMatches(workspaceId, claim, [prUrl]);
    const prId = ids[0];
    if (!prId) {
      return { success: false, reason: 'claim_stale' };
    }
    this.emit(PR_URL_ATTACHED, { workspaceId, prId, prUrl } satisfies PRUrlAttachedEvent);
    return await this.refreshPR({ workspaceId, prId });
  }
  async attachDiscoveredPRsAndRefresh(
    workspaceId: string,
    urls: string[],
    claim: GitHubPRDiscoveryClaim
  ): Promise<number> {
    const ids = await this.workspace.attachDiscoveredPRsIfClaimMatches(workspaceId, claim, urls);
    for (const prId of ids) {
      const pr = await this.workspace.findPR({ workspaceId, prId });
      if (!pr) {
        continue;
      }
      this.emit(PR_URL_ATTACHED, { workspaceId, prId, prUrl: pr.url } satisfies PRUrlAttachedEvent);
      await this.refreshPR({ workspaceId, prId });
    }
    return ids.length;
  }
  async recordPrObservation(workspaceId: string, input: PrObservationInput): Promise<void> {
    const prs = await this.workspace.listPRs(workspaceId);
    const pr = prs.find((pr) => pr.url === input.prUrl && (!input.prId || pr.id === input.prId));
    if (!pr) {
      return;
    }
    const result = await this.workspace.applyPrObservationWithDispatchReset(workspaceId, {
      prId: pr.id,
      expectedRevision: input.expectedRevision ?? pr.revision,
      expectedPrUrl: pr.url,
      expectedPrNumber: input.prNumber,
      prCiStatus: input.ciStatus,
      prState: input.prState,
      prReviewState: input.reviewState,
      prHasMergeConflict: input.hasMergeConflict,
      prUpdatedAt: input.observedAt ?? new Date(),
      ...(input.failedAt !== undefined ? { prCiFailedAt: input.failedAt } : {}),
    });
    if (result.applied) {
      this.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId,
        prId: pr.id,
        prUrl: pr.url,
        prNumber: input.prNumber,
        prState: input.prState,
        prCiStatus: input.ciStatus,
        prReviewState: input.reviewState,
        ...(result.dispatchReset ? { ratchetDispatchChanged: true as const } : {}),
      } satisfies PRSnapshotUpdatedEvent);
    }
  }
  async recordReviewCheck(workspaceId: string, input: ReviewCheckInput = {}): Promise<void> {
    const prs = await this.workspace.listPRs(workspaceId);
    const pr = input.prId
      ? prs.find((pr) => pr.id === input.prId)
      : prs.length === 1
        ? prs[0]
        : undefined;
    if (!pr) {
      return;
    }
    await this.workspace.applyPrSnapshotWithDispatchReset(workspaceId, {
      prId: pr.id,
      expectedRevision: pr.revision,
      prNumber: pr.number ?? githubCLIService.extractPRInfo(pr.url)?.number ?? 0,
      prState: pr.state,
      prReviewState: pr.reviewState,
      prCiStatus: pr.ciStatus,
      prUpdatedAt: pr.syncedAt ?? new Date(),
      prReviewLastCheckedAt: input.checkedAt === null ? null : (input.checkedAt ?? new Date()),
      ...(input.latestCommentId !== undefined
        ? { prReviewLastCommentId: input.latestCommentId }
        : {}),
    });
  }
  async applySnapshot(
    workspaceId: string,
    snapshot: SnapshotData,
    options: ApplySnapshotOptions = {}
  ): Promise<void> {
    if (options.persistPrUrl) {
      await this.attachAndRefreshPR(workspaceId, options.persistPrUrl);
      return;
    }
    const prs = await this.workspace.listPRs(workspaceId);
    const pr = prs.find((pr) =>
      options.prId
        ? pr.id === options.prId
        : options.eventPrUrl
          ? pr.url === options.eventPrUrl
          : prs.length === 1
    );
    if (!pr) {
      return;
    }
    const result = await this.workspace.applyPrSnapshotWithDispatchReset(workspaceId, {
      ...snapshot,
      prId: pr.id,
      expectedRevision: options.expectedRevision ?? pr.revision,
      prUpdatedAt: new Date(),
    });
    if (result.applied) {
      this.emit(PR_SNAPSHOT_UPDATED, {
        workspaceId,
        prId: pr.id,
        prUrl: pr.url,
        ...snapshot,
      } satisfies PRSnapshotUpdatedEvent);
    }
  }
}
export const prSnapshotService = new PRSnapshotService();
