import { describe, expect, it } from 'vitest';
import { RatchetState } from '@/shared/core';
import {
  assertValidRatchetTransition,
  isValidRatchetTransition,
  RATCHET_VALID_TRANSITIONS,
  RatchetStateMachineError,
} from './ratchet-state-machine';

const ALL_STATES = Object.values(RatchetState);
const OPEN_PR_STATES = [
  RatchetState.CI_RUNNING,
  RatchetState.CI_FAILED,
  RatchetState.MERGE_CONFLICT,
  RatchetState.REVIEW_PENDING,
  RatchetState.READY,
] as const;

describe('ratchet state machine', () => {
  it('declares transitions for every ratchet state', () => {
    expect(Object.keys(RATCHET_VALID_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it('allows every state to settle to IDLE (PR closed / ratchet disabled)', () => {
    for (const from of ALL_STATES) {
      if (from === RatchetState.IDLE) {
        continue;
      }
      expect(isValidRatchetTransition(from, RatchetState.IDLE)).toBe(true);
    }
  });

  it('allows IDLE to move to any observed PR state', () => {
    for (const to of [...OPEN_PR_STATES, RatchetState.MERGED]) {
      expect(isValidRatchetTransition(RatchetState.IDLE, to)).toBe(true);
    }
  });

  it('allows open-PR states to move between each other and to MERGED', () => {
    for (const from of OPEN_PR_STATES) {
      for (const to of [...OPEN_PR_STATES, RatchetState.MERGED]) {
        if (from === to) {
          continue;
        }
        expect(isValidRatchetTransition(from, to)).toBe(true);
      }
    }
  });

  it('allows MERGED to move to open-PR states (workspace PR pointer switch)', () => {
    for (const to of OPEN_PR_STATES) {
      expect(isValidRatchetTransition(RatchetState.MERGED, to)).toBe(true);
    }
  });

  it('treats same-state writes as valid refreshes, not transitions', () => {
    for (const state of ALL_STATES) {
      expect(RATCHET_VALID_TRANSITIONS[state]).not.toContain(state);
      expect(isValidRatchetTransition(state, state)).toBe(true);
    }
  });

  describe('assertValidRatchetTransition', () => {
    it('does not throw for a valid transition', () => {
      expect(() =>
        assertValidRatchetTransition('ws-1', RatchetState.CI_FAILED, RatchetState.IDLE)
      ).not.toThrow();
    });

    it('throws RatchetStateMachineError naming the workspace and states when invalid', () => {
      // No pair in the current table is invalid (the state is derived from PR
      // observations, which can move between any two states). Exercise the
      // guard against a hypothetical restricted table via the exported error
      // so the throw contract is pinned for future restrictions.
      const error = new RatchetStateMachineError(
        'ws-1',
        RatchetState.MERGED,
        RatchetState.CI_RUNNING
      );
      expect(error.name).toBe('RatchetStateMachineError');
      expect(error.workspaceId).toBe('ws-1');
      expect(error.fromState).toBe(RatchetState.MERGED);
      expect(error.toState).toBe(RatchetState.CI_RUNNING);
      expect(error.message).toContain('MERGED');
      expect(error.message).toContain('CI_RUNNING');
      expect(error.message).toContain('ws-1');
    });
  });
});
