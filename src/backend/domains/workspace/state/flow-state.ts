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
  prUpdatedAt: Date | null;
  ratchetEnabled: boolean;
  ratchetState: RatchetState;
}

export type WorkspaceFlowStateSource = Pick<
  WorkspaceFlowStateInput,
  'prUrl' | 'prState' | 'prCiStatus' | 'prUpdatedAt' | 'ratchetEnabled' | 'ratchetState'
>;

export type WorkspaceCiObservation =
  | 'NOT_FETCHED'
  | 'NO_CHECKS'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'CHECKS_PASSED'
  | 'CHECKS_UNKNOWN';

export interface WorkspaceFlowState {
  phase: WorkspaceFlowPhase;
  ciObservation: WorkspaceCiObservation;
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
  RatchetState.REVIEW_PENDING,
]);

function hasActivePr(prUrl: string | null, prState: PRState): boolean {
  if (!prUrl) {
    return false;
  }
  return ACTIVE_PR_STATES.has(prState);
}

function deriveWorkspaceCiObservation(input: WorkspaceFlowStateInput): WorkspaceCiObservation {
  if (input.prCiStatus === CIStatus.PENDING) {
    return 'CHECKS_PENDING';
  }
  if (input.prCiStatus === CIStatus.FAILURE) {
    return 'CHECKS_FAILED';
  }
  if (input.prCiStatus === CIStatus.SUCCESS) {
    return 'CHECKS_PASSED';
  }
  if (input.prCiStatus === CIStatus.UNKNOWN) {
    return input.prUpdatedAt ? 'NO_CHECKS' : 'NOT_FETCHED';
  }
  return 'CHECKS_UNKNOWN';
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
  const ciObservation = deriveWorkspaceCiObservation(input);

  if (input.prState === PRState.MERGED) {
    return {
      phase: 'MERGED',
      ciObservation,
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: false,
    };
  }

  if (!activePr) {
    return {
      phase: 'NO_PR',
      ciObservation,
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: false,
    };
  }

  if (ciObservation === 'NOT_FETCHED' || ciObservation === 'CHECKS_PENDING') {
    return {
      phase: 'CI_WAIT',
      ciObservation,
      isWorking: true,
      shouldAnimateRatchetButton: input.ratchetEnabled,
      hasActivePr: true,
    };
  }

  if (!input.ratchetEnabled) {
    return {
      phase: 'READY',
      ciObservation,
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: true,
    };
  }

  if (RATCHET_FIXING_STATES.has(input.ratchetState)) {
    return {
      phase: 'RATCHET_FIXING',
      ciObservation,
      isWorking: true,
      shouldAnimateRatchetButton: false,
      hasActivePr: true,
    };
  }

  if (input.ratchetState === RatchetState.READY || input.ratchetState === RatchetState.MERGED) {
    return {
      phase: 'READY',
      ciObservation,
      isWorking: false,
      shouldAnimateRatchetButton: false,
      hasActivePr: true,
    };
  }

  return {
    phase: 'RATCHET_VERIFY',
    ciObservation,
    isWorking: true,
    shouldAnimateRatchetButton: false,
    hasActivePr: true,
  };
}

export function deriveWorkspaceFlowStateFromWorkspace(
  workspace: WorkspaceFlowStateSource
): WorkspaceFlowState {
  return deriveWorkspaceFlowState({
    prUrl: workspace.prUrl,
    prState: workspace.prState,
    prCiStatus: workspace.prCiStatus,
    prUpdatedAt: workspace.prUpdatedAt,
    ratchetEnabled: workspace.ratchetEnabled,
    ratchetState: workspace.ratchetState,
  });
}
