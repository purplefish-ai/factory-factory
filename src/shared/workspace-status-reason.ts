import type {
  AutoIterationStatus,
  CIStatus,
  PRState,
  RatchetState,
  WorkspaceMode,
  WorkspaceStatus,
} from '@/shared/core';
import type { WorkspaceCiObservation, WorkspaceFlowPhase } from '@/shared/workspace-flow-state';

export const WORKSPACE_PENDING_REQUEST_TYPES = [
  'plan_approval',
  'user_question',
  'permission_request',
] as const;

export type WorkspacePendingRequestType = (typeof WORKSPACE_PENDING_REQUEST_TYPES)[number];

export const WORKSPACE_STATUS_REASON_TONES = [
  'neutral',
  'working',
  'waiting',
  'attention',
  'success',
  'danger',
] as const;

export type WorkspaceStatusReasonTone = (typeof WORKSPACE_STATUS_REASON_TONES)[number];

export const WORKSPACE_STATUS_REASON_CODES = [
  'NEEDS_PERMISSION',
  'NEEDS_PLAN_APPROVAL',
  'NEEDS_ANSWER',
  'SESSION_ERROR',
  'SETTING_UP',
  'SETUP_FAILED',
  'ARCHIVING',
  'ARCHIVED',
  'AGENT_WORKING',
  'STARTING_SESSION',
  'AUTO_ITERATING',
  'WAITING_FOR_CI',
  'FIXING_CI_FAILURES',
  'FIXING_REVIEW_COMMENTS',
  'FIXING_MERGE_CONFLICT',
  'MERGE_CONFLICT',
  'RATCHET_STALLED',
  'CHECKING_PR',
  'MERGED',
  'PR_CLOSED',
  'READY_TO_MERGE',
  'READY_FOR_REVIEW',
  'NO_SESSION_STARTED',
  'READY_FOR_NEXT_PROMPT',
] as const;

export type WorkspaceStatusReasonCode = (typeof WORKSPACE_STATUS_REASON_CODES)[number];

export interface WorkspaceStatusReason {
  code: WorkspaceStatusReasonCode;
  label: string;
  tone: WorkspaceStatusReasonTone;
  needsUser: boolean;
}

export interface WorkspaceStatusReasonInput {
  lifecycle: WorkspaceStatus;
  hasHadSessions: boolean;
  isWorking: boolean;
  isSessionStarting: boolean;
  pendingRequestType: WorkspacePendingRequestType | null;
  hasSessionRuntimeError?: boolean;
  flowPhase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
  prState: PRState;
  prCiStatus: CIStatus;
  ratchetState: RatchetState;
  ratchetEnabled: boolean;
  hasMergeConflict: boolean;
  dispatchStalled: boolean;
  mode: WorkspaceMode;
  autoIterationStatus: AutoIterationStatus | null;
}

type OptionalWorkspaceStatusReason = WorkspaceStatusReason | null;

function reason(
  code: WorkspaceStatusReasonCode,
  label: string,
  tone: WorkspaceStatusReasonTone,
  needsUser = false
): WorkspaceStatusReason {
  return { code, label, tone, needsUser };
}

export function deriveWorkspaceStatusReason(
  input: WorkspaceStatusReasonInput
): WorkspaceStatusReason {
  return (
    deriveBlockingReason(input) ??
    deriveLifecycleReason(input) ??
    deriveActiveReason(input) ??
    deriveRatchetTroubleReason(input) ??
    derivePrFlowReason(input) ??
    deriveIdleReason(input)
  );
}

function deriveBlockingReason(input: WorkspaceStatusReasonInput): OptionalWorkspaceStatusReason {
  switch (input.pendingRequestType) {
    case 'permission_request':
      return reason('NEEDS_PERMISSION', 'Needs permission', 'attention', true);
    case 'plan_approval':
      return reason('NEEDS_PLAN_APPROVAL', 'Needs plan approval', 'attention', true);
    case 'user_question':
      return reason('NEEDS_ANSWER', 'Needs your answer', 'attention', true);
  }

  if (input.hasSessionRuntimeError) {
    return reason('SESSION_ERROR', 'Session error', 'danger', true);
  }

  return null;
}

function deriveLifecycleReason(input: WorkspaceStatusReasonInput): OptionalWorkspaceStatusReason {
  if (input.lifecycle === 'NEW' || input.lifecycle === 'PROVISIONING') {
    return reason('SETTING_UP', 'Setting up workspace', 'working');
  }
  if (input.lifecycle === 'FAILED') {
    return reason('SETUP_FAILED', 'Setup failed', 'danger', true);
  }
  if (input.lifecycle === 'ARCHIVING') {
    return reason('ARCHIVING', 'Archiving', 'working');
  }
  if (input.lifecycle === 'ARCHIVED') {
    return reason('ARCHIVED', 'Archived', 'neutral');
  }

  return null;
}

function deriveActiveReason(input: WorkspaceStatusReasonInput): OptionalWorkspaceStatusReason {
  if (input.isWorking) {
    return reason('AGENT_WORKING', 'Agent working', 'working');
  }

  if (input.isSessionStarting) {
    return reason('STARTING_SESSION', 'Starting session', 'working');
  }

  if (input.mode === 'AUTO_ITERATION' && input.autoIterationStatus === 'RUNNING') {
    return reason('AUTO_ITERATING', 'Auto-iterating', 'working');
  }

  return null;
}

/**
 * The two PR states the automation cannot make progress on by itself.
 *
 * Split out of `derivePrFlowReason` only to keep that function under the
 * cognitive-complexity limit; it runs immediately before it, so the precedence
 * is the same as if these were its first two branches.
 */
function deriveRatchetTroubleReason(
  input: WorkspaceStatusReasonInput
): OptionalWorkspaceStatusReason {
  if (input.ratchetEnabled && input.dispatchStalled) {
    return reason('RATCHET_STALLED', 'Auto-fix stalled', 'attention', true);
  }

  if (input.hasMergeConflict) {
    return input.ratchetEnabled
      ? reason('FIXING_MERGE_CONFLICT', 'Fixing merge conflict', 'working')
      : reason('MERGE_CONFLICT', 'Merge conflict', 'attention', true);
  }

  return null;
}

function derivePrFlowReason(input: WorkspaceStatusReasonInput): OptionalWorkspaceStatusReason {
  if (input.flowPhase === 'CI_WAIT') {
    return reason('WAITING_FOR_CI', 'Waiting for CI', 'waiting');
  }

  if (input.flowPhase === 'RATCHET_FIXING') {
    if (input.ratchetState === 'REVIEW_PENDING') {
      return reason('FIXING_REVIEW_COMMENTS', 'Fixing review comments', 'working');
    }
    return reason('FIXING_CI_FAILURES', 'Fixing CI failures', 'working');
  }

  if (input.flowPhase === 'RATCHET_VERIFY') {
    return reason('CHECKING_PR', 'Checking PR', 'working');
  }

  if (
    input.flowPhase === 'MERGED' ||
    input.prState === 'MERGED' ||
    input.ratchetState === 'MERGED'
  ) {
    return reason('MERGED', 'Merged', 'success');
  }

  if (input.prState === 'CLOSED') {
    return reason('PR_CLOSED', 'PR closed', 'neutral');
  }

  if (input.flowPhase === 'READY' && input.ciObservation === 'CHECKS_PASSED') {
    return reason('READY_TO_MERGE', 'Ready to merge', 'success', true);
  }

  if (input.flowPhase === 'READY') {
    return reason('READY_FOR_REVIEW', 'Ready for review', 'neutral', true);
  }

  return null;
}

function deriveIdleReason(input: WorkspaceStatusReasonInput): WorkspaceStatusReason {
  if (!input.hasHadSessions) {
    return reason('NO_SESSION_STARTED', 'No session started', 'neutral', true);
  }

  return reason('READY_FOR_NEXT_PROMPT', 'Ready for next prompt', 'neutral', true);
}
