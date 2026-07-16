import { createLogger } from '@/backend/services/logger.service';
import type { RatchetState } from '@/shared/core';
import type {
  PRStateInfo,
  RatchetAction,
  RatchetDecisionContext,
  WorkspaceWithPR,
} from './ratchet.types';
import {
  buildFailedCheckDiagnostics,
  buildReviewTimestampDiagnostics,
  buildSnapshotDiagnostics,
} from './ratchet-pr-state.helpers';

const logger = createLogger('ratchet');

function describeNonRatchetingReason(
  action: Exclude<RatchetAction, { type: 'TRIGGERED_FIXER' }>
): string {
  switch (action.type) {
    case 'WAITING':
      return action.reason;
    case 'FIXER_ACTIVE':
      return `Ratchet fixer session is already active (${action.sessionId})`;
    case 'DISABLED':
      return action.reason;
    case 'COMPLETED':
      return 'PR is already merged';
    case 'ERROR':
      return action.error;
  }
  const exhaustiveCheck: never = action;
  throw new Error(`Unhandled ratchet action: ${JSON.stringify(exhaustiveCheck)}`);
}

export function buildRatchetingLogContext(params: {
  workspace: WorkspaceWithPR;
  previousState: RatchetState;
  newState: RatchetState;
  action: RatchetAction;
  prStateInfo: PRStateInfo | null;
  prNumber: number | null;
  decisionContext: RatchetDecisionContext | null;
}) {
  const { workspace, previousState, newState, action, prStateInfo, prNumber, decisionContext } =
    params;
  const reviewDiagnostics = buildReviewTimestampDiagnostics(
    workspace,
    prStateInfo,
    decisionContext
  );
  const snapshotDiagnostics = buildSnapshotDiagnostics(workspace, prStateInfo, decisionContext);
  const latestReviewActivityAt = reviewDiagnostics.latestReviewActivityAtMs;

  return {
    workspaceId: workspace.id,
    prUrl: workspace.prUrl,
    prNumber,
    prState: prStateInfo?.prState ?? null,
    ciStatus: prStateInfo?.ciStatus ?? null,
    hasChangesRequested: prStateInfo?.hasChangesRequested ?? null,
    hasMergeConflict: prStateInfo?.hasMergeConflict ?? null,
    snapshotKey: prStateInfo?.snapshotKey ?? null,
    ciSnapshotKey: snapshotDiagnostics.ciSnapshotKey,
    snapshotComparison: snapshotDiagnostics.snapshotComparison,
    previousState,
    newState,
    ratchetEnabled: workspace.ratchetEnabled,
    ratchetActiveSessionId: workspace.ratchetActiveSessionId,
    ratchetLastCiRunId: workspace.ratchetLastCiRunId,
    dispatchOutcome: decisionContext?.dispatchOutcome ?? workspace.ratchetDispatchOutcome,
    dispatchRetryCount: decisionContext?.dispatchRetryCount ?? workspace.ratchetDispatchRetryCount,
    ciStatusCheckRollup: prStateInfo?.statusCheckRollup ?? null,
    ciFailedChecks: buildFailedCheckDiagnostics(prStateInfo),
    prReviewLastCheckedAt: workspace.prReviewLastCheckedAt?.toISOString() ?? null,
    latestReviewActivityAt: latestReviewActivityAt
      ? new Date(latestReviewActivityAt).toISOString()
      : null,
    reviewTimestampComparison: reviewDiagnostics.reviewTimestampComparison,
    actionType: action.type,
  };
}

export function logWorkspaceRatchetingDecision(params: {
  workspace: WorkspaceWithPR;
  previousState: RatchetState;
  newState: RatchetState;
  action: RatchetAction;
  prStateInfo: PRStateInfo | null;
  decisionContext?: RatchetDecisionContext | null;
}): void {
  const { workspace, previousState, newState, action, prStateInfo } = params;
  const decisionContext = params.decisionContext ?? null;
  const prNumber = prStateInfo?.prNumber ?? workspace.prNumber;
  const prNumberLabel = prNumber ?? 'unknown';
  const workspacePrPrefix = `workspace ${workspace.id} for PR #${prNumberLabel}`;
  const context = buildRatchetingLogContext({
    workspace,
    previousState,
    newState,
    action,
    prStateInfo,
    prNumber,
    decisionContext,
  });

  if (action.type === 'TRIGGERED_FIXER') {
    logger.info(`Ratcheting ${workspacePrPrefix}`, {
      ...context,
      sessionId: action.sessionId,
      promptSent: action.promptSent,
    });
    return;
  }

  const reason = describeNonRatchetingReason(action);
  logger.info(`Not ratcheting ${workspacePrPrefix} because ${reason}`, context);
}
