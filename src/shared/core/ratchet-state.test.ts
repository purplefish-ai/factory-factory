import { describe, expect, it } from 'vitest';
import { CIStatus, PRState, RatchetState } from './enums.js';
import { deriveRatchetState, type RatchetStateInput } from './ratchet-state.js';

function input(overrides: Partial<RatchetStateInput> = {}): RatchetStateInput {
  return {
    ratchetEnabled: true,
    prState: PRState.OPEN,
    prCiStatus: CIStatus.SUCCESS,
    prHasMergeConflict: false,
    prReviewState: null,
    ...overrides,
  };
}

describe('deriveRatchetState', () => {
  it('is IDLE whenever ratcheting is off, whatever the PR says', () => {
    for (const prState of Object.values(PRState)) {
      for (const prCiStatus of Object.values(CIStatus)) {
        expect(
          deriveRatchetState(
            input({ ratchetEnabled: false, prState, prCiStatus, prHasMergeConflict: true })
          )
        ).toBe(RatchetState.IDLE);
      }
    }
  });

  it('is MERGED for a merged PR before anything else is considered', () => {
    expect(
      deriveRatchetState(
        input({
          prState: PRState.MERGED,
          prCiStatus: CIStatus.FAILURE,
          prHasMergeConflict: true,
          prReviewState: 'CHANGES_REQUESTED',
        })
      )
    ).toBe(RatchetState.MERGED);
  });

  it('is IDLE for a PR that is neither open nor merged', () => {
    expect(deriveRatchetState(input({ prState: PRState.CLOSED }))).toBe(RatchetState.IDLE);
    expect(deriveRatchetState(input({ prState: PRState.NONE }))).toBe(RatchetState.IDLE);
  });

  it('treats draft, approved and changes-requested PRs as open', () => {
    // The cache folds draft and review decision into `PRState`, where the
    // ratchet's own fetch saw a plain `OPEN`. All four have to keep counting as
    // open or the state would collapse to IDLE the moment a PR was reviewed.
    for (const prState of [
      PRState.OPEN,
      PRState.DRAFT,
      PRState.APPROVED,
      PRState.CHANGES_REQUESTED,
    ]) {
      expect(deriveRatchetState(input({ prState, prCiStatus: CIStatus.FAILURE }))).toBe(
        RatchetState.CI_FAILED
      );
    }
  });

  it('ranks a failing build above a merge conflict', () => {
    expect(
      deriveRatchetState(input({ prCiStatus: CIStatus.FAILURE, prHasMergeConflict: true }))
    ).toBe(RatchetState.CI_FAILED);
  });

  it('ranks a merge conflict above pending CI', () => {
    // A PR can carry conflicts with no CI configured at all, so the conflict has
    // to outrank the pending/unknown branch rather than wait behind it.
    expect(
      deriveRatchetState(input({ prCiStatus: CIStatus.PENDING, prHasMergeConflict: true }))
    ).toBe(RatchetState.MERGE_CONFLICT);
    expect(
      deriveRatchetState(input({ prCiStatus: CIStatus.UNKNOWN, prHasMergeConflict: true }))
    ).toBe(RatchetState.MERGE_CONFLICT);
  });

  it('is CI_RUNNING for pending and for unknown CI', () => {
    expect(deriveRatchetState(input({ prCiStatus: CIStatus.PENDING }))).toBe(
      RatchetState.CI_RUNNING
    );
    expect(deriveRatchetState(input({ prCiStatus: CIStatus.UNKNOWN }))).toBe(
      RatchetState.CI_RUNNING
    );
  });

  it('is REVIEW_PENDING on a green PR with changes requested', () => {
    expect(deriveRatchetState(input({ prReviewState: 'CHANGES_REQUESTED' }))).toBe(
      RatchetState.REVIEW_PENDING
    );
  });

  it('reads the review decision, not PRState, so a draft cannot mask it', () => {
    // `computePRState` returns DRAFT for a draft PR even when changes were
    // requested, which is why the raw `reviewDecision` is the input here.
    expect(
      deriveRatchetState(input({ prState: PRState.DRAFT, prReviewState: 'CHANGES_REQUESTED' }))
    ).toBe(RatchetState.REVIEW_PENDING);
  });

  it('is READY on a green PR with no conflict and no changes requested', () => {
    expect(deriveRatchetState(input({ prReviewState: 'APPROVED' }))).toBe(RatchetState.READY);
    expect(deriveRatchetState(input({ prReviewState: null }))).toBe(RatchetState.READY);
    expect(deriveRatchetState(input({ prReviewState: 'REVIEW_REQUIRED' }))).toBe(
      RatchetState.READY
    );
  });

  it('is a pure function: the same inputs always give the same answer', () => {
    const fixed = input({ prCiStatus: CIStatus.FAILURE });
    const answers = new Set(Array.from({ length: 5 }, () => deriveRatchetState(fixed)));
    expect(answers).toEqual(new Set([RatchetState.CI_FAILED]));
  });

  it('can reach every state in the enum', () => {
    // The state is worth keeping as a vocabulary only if the projection actually
    // produces all of it; an unreachable value would be a sign the derivation had
    // lost an input rather than moved it.
    const reached = new Set([
      deriveRatchetState(input({ ratchetEnabled: false })),
      deriveRatchetState(input({ prState: PRState.MERGED })),
      deriveRatchetState(input({ prCiStatus: CIStatus.FAILURE })),
      deriveRatchetState(input({ prHasMergeConflict: true })),
      deriveRatchetState(input({ prCiStatus: CIStatus.PENDING })),
      deriveRatchetState(input({ prReviewState: 'CHANGES_REQUESTED' })),
      deriveRatchetState(input()),
    ]);
    expect(reached).toEqual(new Set(Object.values(RatchetState)));
  });
});
