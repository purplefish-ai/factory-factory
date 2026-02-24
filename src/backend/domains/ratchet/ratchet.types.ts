import type { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import type { CIStatus, RatchetState } from '@/shared/core';

export interface RatchetStatusCheckRollupItem {
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
}

export interface PRStateInfo {
  ciStatus: CIStatus;
  snapshotKey: string;
  hasChangesRequested: boolean;
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

export interface ReviewPollTracker {
  snapshotKey: string;
  lastPolledAt: number;
  pollCount: number;
}

export type ReviewPollResult =
  | { action: 'waiting' }
  | { action: 'comments-found'; freshPrState: PRStateInfo };

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

export interface RatchetDecisionContext {
  workspace: WorkspaceWithPR;
  prStateInfo: PRStateInfo;
  previousState: RatchetState;
  newState: RatchetState;
  finalState: RatchetState;
  hasNewReviewActivitySinceLastDispatch: boolean;
  hasStateChangedSinceLastDispatch: boolean;
  isCleanPrWithNoNewReviewActivity: boolean;
  activeRatchetSession: RatchetAction | null;
  hasOtherActiveSession: boolean;
}

export type RatchetDecision =
  | { type: 'RETURN_ACTION'; action: RatchetAction }
  | { type: 'TRIGGER_FIXER' };
