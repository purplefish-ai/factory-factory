import type { createLogger } from '@/backend/services/logger.service';
import type {
  PRStateInfo,
  RatchetAction,
  RatchetDecision,
  RatchetDecisionContext,
  ReviewPollResult,
  ReviewPollTracker,
  WorkspaceRatchetResult,
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

export async function processReviewCommentPoll(params: {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  authenticatedUsername: string | null;
  handleReviewCommentPoll: (
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    authenticatedUsername: string | null
  ) => Promise<ReviewPollResult>;
  buildRatchetDecisionContext: (
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo
  ) => Promise<RatchetDecisionContext>;
  decideRatchetAction: (context: RatchetDecisionContext) => RatchetDecision;
  applyRatchetDecision: (
    context: RatchetDecisionContext,
    decision: RatchetDecision
  ) => Promise<RatchetAction>;
  updateWorkspaceAfterCheck: (
    workspace: WorkspaceWithPR,
    prStateInfo: PRStateInfo,
    action: RatchetAction,
    nextState: RatchetDecisionContext['finalState']
  ) => Promise<void>;
  emitStateChange: (
    workspace: WorkspaceWithPR,
    fromState: RatchetDecisionContext['previousState'],
    toState: RatchetDecisionContext['finalState']
  ) => void;
  logWorkspaceRatchetingDecision: (
    workspace: WorkspaceWithPR,
    previousState: RatchetDecisionContext['previousState'],
    finalState: RatchetDecisionContext['finalState'],
    action: RatchetAction,
    prStateInfo: PRStateInfo,
    context: RatchetDecisionContext
  ) => void;
}): Promise<WorkspaceRatchetResult | null> {
  const {
    workspace,
    prStateInfo,
    authenticatedUsername,
    handleReviewCommentPoll: handlePoll,
    buildRatchetDecisionContext,
    decideRatchetAction,
    applyRatchetDecision,
    updateWorkspaceAfterCheck,
    emitStateChange,
    logWorkspaceRatchetingDecision,
  } = params;

  const pollResult = await handlePoll(workspace, prStateInfo, authenticatedUsername);

  if (pollResult.action !== 'comments-found') {
    return null;
  }

  const freshContext = await buildRatchetDecisionContext(workspace, pollResult.freshPrState);
  const freshDecision = decideRatchetAction(freshContext);
  const freshAction = await applyRatchetDecision(freshContext, freshDecision);

  await updateWorkspaceAfterCheck(
    workspace,
    pollResult.freshPrState,
    freshAction,
    freshContext.finalState
  );
  if (freshContext.previousState !== freshContext.finalState) {
    emitStateChange(workspace, freshContext.previousState, freshContext.finalState);
  }

  logWorkspaceRatchetingDecision(
    workspace,
    freshContext.previousState,
    freshContext.finalState,
    freshAction,
    pollResult.freshPrState,
    freshContext
  );

  return {
    workspaceId: workspace.id,
    previousState: freshContext.previousState,
    newState: freshContext.finalState,
    action: freshAction,
  };
}
