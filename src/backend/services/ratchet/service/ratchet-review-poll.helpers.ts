import type { createLogger } from '@/backend/services/logger.service';
import type {
  PRStateInfo,
  ReviewPollResult,
  ReviewPollTracker,
  WorkspaceWithPR,
} from './ratchet.types';

type Logger = ReturnType<typeof createLogger>;

/** Interval (ms) between review comment re-polls while PR is open and clean. */
export const REVIEW_POLL_INTERVAL_MS = 2 * 60_000; // 2 min

export async function handleReviewCommentPoll(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  authenticatedUsername: string | null;
  reviewPollTrackers: Map<string, ReviewPollTracker>;
  isShuttingDown: boolean;
  fetchPRState: (
    workspace: WorkspaceWithPR,
    authenticatedUsername: string | null
  ) => Promise<PRStateInfo | null>;
  shouldSkipCleanPR: (workspace: WorkspaceWithPR, prStateInfo: PRStateInfo) => boolean;
  logger: Logger;
}): Promise<ReviewPollResult> {
  const {
    workspace,
    prStateInfo,
    authenticatedUsername,
    reviewPollTrackers,
    isShuttingDown,
    fetchPRState,
    shouldSkipCleanPR,
    logger,
  } = params;

  const existing = reviewPollTrackers.get(workspace.id);

  if (!existing) {
    reviewPollTrackers.set(workspace.id, {
      snapshotKey: prStateInfo.snapshotKey,
      lastPolledAt: Date.now(),
      pollCount: 0,
    });
    logger.info('Started review comment polling', {
      workspaceId: workspace.id,
      snapshotKey: prStateInfo.snapshotKey,
    });
    return { action: 'waiting' };
  }

  if (existing.snapshotKey !== prStateInfo.snapshotKey) {
    reviewPollTrackers.set(workspace.id, {
      snapshotKey: prStateInfo.snapshotKey,
      lastPolledAt: Date.now(),
      pollCount: 0,
    });
    logger.info('Reset review comment polling (new snapshot)', {
      workspaceId: workspace.id,
      snapshotKey: prStateInfo.snapshotKey,
    });
    return { action: 'waiting' };
  }

  if (Date.now() - existing.lastPolledAt < REVIEW_POLL_INTERVAL_MS) {
    return { action: 'waiting' };
  }

  if (isShuttingDown) {
    return { action: 'waiting' };
  }

  const freshPrState = await fetchPRState(workspace, authenticatedUsername);

  if (!freshPrState) {
    return { action: 'waiting' };
  }

  existing.pollCount++;
  existing.lastPolledAt = Date.now();

  if (!shouldSkipCleanPR(workspace, freshPrState)) {
    reviewPollTrackers.delete(workspace.id);
    logger.info('Review comments detected during poll', {
      workspaceId: workspace.id,
      pollNumber: existing.pollCount,
      latestReviewActivityAtMs: freshPrState.latestReviewActivityAtMs,
    });
    return { action: 'comments-found', freshPrState };
  }

  return { action: 'waiting' };
}
