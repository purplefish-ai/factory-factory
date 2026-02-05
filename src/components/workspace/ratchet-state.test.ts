import { describe, expect, it } from 'vitest';
import { getRatchetStateLabel, getRatchetVisualState } from './ratchet-state';

describe('ratchet-state', () => {
  it('computes visual state from enabled and ratchet state', () => {
    expect(getRatchetVisualState(false, true)).toBe('off');
    expect(getRatchetVisualState(true, false)).toBe('idle');
    expect(getRatchetVisualState(true, true)).toBe('processing');
  });

  it('returns a safe label for missing state', () => {
    expect(getRatchetStateLabel(undefined)).toBe('Idle');
    expect(getRatchetStateLabel(null)).toBe('Idle');
  });
});
