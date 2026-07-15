import type { RatchetDispatchOutcome } from '@prisma-gen/client';
import type { workspaceAccessor } from '@/backend/services/workspace';
import type { CIStatus, RatchetState } from '@/shared/core';

export interface RatchetStatusCheckRollupItem {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PRStateInfo {
  ciStatus: CIStatus;
  snapshotKey: string;
  hasChangesRequested: boolean;
  hasMergeConflict: boolean;
  latestReviewActivityAtMs: number | null;
  statusCheckRollup: RatchetStatusCheckRollupItem[] | null;
  prState: string;
  prNumber: number;
  reviewComments: Array<{
    author: string;
    body: string;
    path: string;
    line: number | null;
    url: string;
  }>;
}

export interface PRStateFetchSkipped {
  skipped: true;
  reason: 'recently_fetched';
}

export type PRStateFetchResult = PRStateInfo | PRStateFetchSkipped | null;

export type RatchetAction =
  | { type: 'WAITING'; reason: string }
  | { type: 'FIXER_ACTIVE'; sessionId: string }
  | { type: 'TRIGGERED_FIXER'; sessionId: string; promptSent: boolean }
  | { type: 'DISABLED'; reason: string }
  | { type: 'COMPLETED' }
  | { type: 'ERROR'; error: string };

export interface WorkspaceRatchetResult {
  workspaceId: string;
  previousState: RatchetState;
  newState: RatchetState;
  action: RatchetAction;
}

export interface RatchetCheckResult {
  checked: number;
  stateChanges: number;
  actionsTriggered: number;
  results: WorkspaceRatchetResult[];
}

export type WorkspaceWithPR = NonNullable<
  Awaited<ReturnType<(typeof workspaceAccessor)['findForRatchetById']>>
>;

/**
 * Result of verifying the recorded fixer session pointer against reality.
 * 'settled' means this check transitioned the dispatch record out of RUNNING;
 * 'ended_concurrently' means another path (lifecycle exit hook / stop) settled
 * it while this check was in flight, so the record read at the start of the
 * check is stale and the decision should wait for the next cycle.
 */
export type ActiveFixerCheckResult =
  | { kind: 'none' }
  | { kind: 'active'; action: RatchetAction }
  | { kind: 'settled'; outcome: RatchetDispatchOutcome }
  | { kind: 'ended_concurrently' };

export interface RatchetDecisionContext {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  previousState: RatchetState;
  newState: RatchetState;
  finalState: RatchetState;
  hasNewReviewActivitySinceLastDispatch: boolean;
  hasStateChangedSinceLastDispatch: boolean;
  isCleanPrWithNoNewReviewActivity: boolean;
  activeFixerCheck: ActiveFixerCheckResult;
  /** Dispatch outcome after any settling done by this check. */
  dispatchOutcome: RatchetDispatchOutcome | null;
  dispatchRetryCount: number;
  hasOtherActiveSession: boolean;
}

export type RatchetDecision =
  | { type: 'RETURN_ACTION'; action: RatchetAction }
  | { type: 'TRIGGER_FIXER'; retryCount: number };
