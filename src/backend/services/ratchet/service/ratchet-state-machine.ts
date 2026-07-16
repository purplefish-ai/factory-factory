/**
 * Ratchet State Machine
 *
 * `Workspace.ratchetState` is a state machine over PR observations, mirroring
 * the workspace lifecycle machine's explicit transition table. Unlike the
 * lifecycle machine, ratchet state is *derived*: each poll observes the PR on
 * GitHub (CI status, merge conflicts, review state) and persists what it saw,
 * so almost any state can follow any other — new commits restart CI, reviews
 * arrive, conflicts appear and resolve, and the workspace's PR pointer can
 * switch to a brand-new PR after the old one merged.
 *
 * The table below therefore encodes intent and acts as a tripwire for future
 * refactors rather than restricting today's graph. The enforced invariant is
 * compare-and-swap on the expected fromState at the point of persistence
 * (see workspaceAccessor.transitionRatchetStateIfEnabled and
 * settleRatchetIdleWhileDisabled), which guarantees that emitted
 * RATCHET_STATE_CHANGED events carry an accurate fromState and that stale
 * in-flight checks cannot overwrite a concurrent transition.
 */

import { RatchetState } from '@/shared/core';

const OPEN_PR_STATES = [
  RatchetState.CI_RUNNING,
  RatchetState.CI_FAILED,
  RatchetState.MERGE_CONFLICT,
  RatchetState.REVIEW_PENDING,
  RatchetState.READY,
] as const;

/**
 * Valid state transitions for ratchet state. Self-transitions are not listed:
 * a same-state write is a refresh (ratchetLastCheckedAt), not a transition.
 */
export const RATCHET_VALID_TRANSITIONS: Record<RatchetState, readonly RatchetState[]> = {
  // IDLE: nothing being ratcheted (no open PR, PR closed, or ratchet disabled).
  // Enabling ratchet on a workspace whose PR is already in any observable
  // state moves directly to that state.
  IDLE: [...OPEN_PR_STATES, RatchetState.MERGED],
  // Open-PR states can move to any other observation (new commits restart CI,
  // reviews arrive, conflicts appear or resolve), settle to IDLE (PR closed or
  // ratchet disabled), or complete as MERGED.
  CI_RUNNING: [
    RatchetState.IDLE,
    RatchetState.CI_FAILED,
    RatchetState.MERGE_CONFLICT,
    RatchetState.REVIEW_PENDING,
    RatchetState.READY,
    RatchetState.MERGED,
  ],
  CI_FAILED: [
    RatchetState.IDLE,
    RatchetState.CI_RUNNING,
    RatchetState.MERGE_CONFLICT,
    RatchetState.REVIEW_PENDING,
    RatchetState.READY,
    RatchetState.MERGED,
  ],
  MERGE_CONFLICT: [
    RatchetState.IDLE,
    RatchetState.CI_RUNNING,
    RatchetState.CI_FAILED,
    RatchetState.REVIEW_PENDING,
    RatchetState.READY,
    RatchetState.MERGED,
  ],
  REVIEW_PENDING: [
    RatchetState.IDLE,
    RatchetState.CI_RUNNING,
    RatchetState.CI_FAILED,
    RatchetState.MERGE_CONFLICT,
    RatchetState.READY,
    RatchetState.MERGED,
  ],
  READY: [
    RatchetState.IDLE,
    RatchetState.CI_RUNNING,
    RatchetState.CI_FAILED,
    RatchetState.MERGE_CONFLICT,
    RatchetState.REVIEW_PENDING,
    RatchetState.MERGED,
  ],
  // MERGED is terminal for the observed PR itself: it can settle to IDLE
  // (ratchet disabled) or move to an open-PR state when the workspace's PR
  // pointer switches to a new PR (event-driven check after a PR switch).
  MERGED: [RatchetState.IDLE, ...OPEN_PR_STATES],
};

/**
 * Error thrown when an invalid ratchet state transition is attempted.
 */
export class RatchetStateMachineError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly fromState: RatchetState,
    public readonly toState: RatchetState,
    message?: string
  ) {
    super(
      message ??
        `Invalid ratchet state transition: ${fromState} → ${toState} (workspace: ${workspaceId})`
    );
    this.name = 'RatchetStateMachineError';
  }
}

export function isValidRatchetTransition(from: RatchetState, to: RatchetState): boolean {
  if (from === to) {
    return true;
  }
  return RATCHET_VALID_TRANSITIONS[from].includes(to);
}

/**
 * Validate a ratchet state transition before persisting it.
 *
 * @throws RatchetStateMachineError if the transition is not in the table
 */
export function assertValidRatchetTransition(
  workspaceId: string,
  fromState: RatchetState,
  toState: RatchetState
): void {
  if (!isValidRatchetTransition(fromState, toState)) {
    throw new RatchetStateMachineError(workspaceId, fromState, toState);
  }
}
