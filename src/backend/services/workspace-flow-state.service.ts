import { CIStatus, PRState, RatchetState } from '@prisma-gen/client';

export type WorkspaceFlowPhase =
  | 'NO_PR'
  | 'CI_WAIT'
  | 'RATCHET_VERIFY'
  | 'RATCHET_FIXING'
  | 'READY'
  | 'MERGED';

export interface WorkspaceFlowStateInput {
  prUrl: string | null;
  prState: PRState;
  prCiStatus: CIStatus;
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
}

export interface WorkspaceFlowState {
  phase: WorkspaceFlowPhase;
  isWorking: boolean;
  shouldAnimateRatchetButton: boolean;
  hasActivePr: boolean;
}

const ACTIVE_PR_STATES = new Set<PRState>([
  PRState.OPEN,
  PRState.DRAFT,
  PRState.CHANGES_REQUESTED,
  PRState.APPROVED,
]);

const RATCHET_FIXING_STATES = new Set<RatchetState>([
  RatchetState.CI_FAILED,
  RatchetState.MERGE_CONFLICT,
  RatchetState.REVIEW_PENDING,
]);

function hasActivePr(prUrl: string | null, prState: PRState): boolean {
  if (!prUrl) {
    return false;
  }
  return ACTIVE_PR_STATES.has(prState);
}

/**
 * Derives a single flow phase used by both backend kanban and frontend ratchet visuals.
 *
 * Rules:
 * - Any active PR waiting on CI is WORKING, regardless of ratchet toggle.
 * - Ratchet button animation is only active when ratchet is enabled AND waiting on CI.
 * - With ratchet enabled, an active PR stays WORKING until ratchet verifies it is READY/MERGED.
 */
export function deriveWorkspaceFlowState(input: WorkspaceFlowStateInput): WorkspaceFlowState {
  const activePr = hasActivePr(input.prUrl, input.prState);

  if (input.prState === PRState.MERGED) {
    return {
      phase: 'MERGED',
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: false,
    };
  }

  if (!activePr) {
    return {
      phase: 'NO_PR',
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: false,
    };
  }

  if (input.prCiStatus === CIStatus.PENDING) {
    return {
      phase: 'CI_WAIT',
      isWorking: true,
      shouldAnimateRatchetButton: input.ratchetEnabled,
      hasActivePr: true,
    };
  }

  if (!input.ratchetEnabled) {
    return {
      phase: 'READY',
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: true,
    };
  }

  if (RATCHET_FIXING_STATES.has(input.ratchetState)) {
    return {
      phase: 'RATCHET_FIXING',
      isWorking: true,
      shouldAnimateRatchetButton: false,
      hasActivePr: true,
    };
  }

  if (input.ratchetState === RatchetState.READY || input.ratchetState === RatchetState.MERGED) {
    return {
      phase: 'READY',
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: true,
    };
  }

  return {
    phase: 'RATCHET_VERIFY',
    isWorking: true,
    shouldAnimateRatchetButton: false,
    hasActivePr: true,
  };
}
