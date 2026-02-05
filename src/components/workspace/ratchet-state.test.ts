import { describe, expect, it } from 'vitest';
import { getRatchetStateLabel, getRatchetVisualState, isRatchetProcessing } from './ratchet-state';

describe('ratchet-state', () => {
  it('returns processing only for active processing states', () => {
    expect(isRatchetProcessing('CI_RUNNING')).toBe(true);
    expect(isRatchetProcessing('CI_FAILED')).toBe(true);
    expect(isRatchetProcessing('MERGE_CONFLICT')).toBe(true);
    expect(isRatchetProcessing('REVIEW_PENDING')).toBe(true);
    expect(isRatchetProcessing('IDLE')).toBe(false);
    expect(isRatchetProcessing('READY')).toBe(false);
    expect(isRatchetProcessing('MERGED')).toBe(false);
  });

  it('computes visual state from enabled and ratchet state', () => {
    expect(getRatchetVisualState(false, 'CI_FAILED')).toBe('off');
    expect(getRatchetVisualState(true, 'IDLE')).toBe('idle');
    expect(getRatchetVisualState(true, 'READY')).toBe('idle');
    expect(getRatchetVisualState(true, 'CI_FAILED')).toBe('processing');
  });

  it('returns a safe label for missing state', () => {
    expect(getRatchetStateLabel(undefined)).toBe('Idle');
    expect(getRatchetStateLabel(null)).toBe('Idle');
  });
});
