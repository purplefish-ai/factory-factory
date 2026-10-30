import { CIStatus, PRState, RatchetState } from './enums.js';
import { isOpenPrState } from './pr-state.js';

/**
 * `RatchetState` is a projection of one PR observation, not state of its own.
 *
 * It used to be a column on `WorkspaceRatchet` (and before that on `Workspace`),
 * written by the ratchet poller behind a compare-and-swap and validated against a
 * 127-line transition table. That table permitted all 49 of its 49 state pairs,
 * so it never rejected anything, and the CAS existed to keep the `fromState` on
 * `RATCHET_STATE_CHANGED` accurate — a field no consumer of that event reads.
 *
 * Every input below is a fact observed from GitHub and cached on `WorkspacePR`,
 * so the state can be computed wherever those fields are read and cannot drift
 * from them. `ratchetEnabled` is part of the projection because a disabled
 * workspace has nothing being ratcheted; that used to be a separate settling
 * write, which left a window where `ratchetState` disagreed with `ratchetEnabled`.
 */
export interface RatchetStateInput {
  ratchetEnabled: boolean;
  prState: PRState;
  prCiStatus: CIStatus;
  prHasMergeConflict: boolean;
  /**
   * GitHub's `reviewDecision`, cached verbatim. Read in preference to
   * `PRState.CHANGES_REQUESTED` because `computePRState` lets `DRAFT` mask the
   * review decision, and a draft PR with changes requested is still
   * `REVIEW_PENDING` to the ratchet.
   */
  prReviewState: string | null;
}

/**
 * Derive the ratchet's view of a workspace from its cached PR observation.
 *
 * Ordering is significant and preserved from the persisted implementation:
 * a failing build outranks a merge conflict, and a conflict outranks pending CI
 * because a PR can carry conflicts with no CI configured at all.
 */
export function deriveRatchetState(input: RatchetStateInput): RatchetState {
  if (!input.ratchetEnabled) {
    return RatchetState.IDLE;
  }

  if (input.prState === PRState.MERGED) {
    return RatchetState.MERGED;
  }

  if (!isOpenPrState(input.prState)) {
    return RatchetState.IDLE;
  }

  if (input.prCiStatus === CIStatus.FAILURE) {
    return RatchetState.CI_FAILED;
  }

  if (input.prHasMergeConflict) {
    return RatchetState.MERGE_CONFLICT;
  }

  if (input.prCiStatus === CIStatus.PENDING || input.prCiStatus === CIStatus.UNKNOWN) {
    return RatchetState.CI_RUNNING;
  }

  if (input.prReviewState === 'CHANGES_REQUESTED') {
    return RatchetState.REVIEW_PENDING;
  }

  return RatchetState.READY;
}
