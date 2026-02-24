import { describe, expect, it } from 'vitest';
import { isDebugFlagEnabled } from './debug';

describe('isDebugFlagEnabled', () => {
  it('returns true for "true"', () => {
    expect(isDebugFlagEnabled('true')).toBe(true);
  });

  it('returns false for "false"', () => {
    expect(isDebugFlagEnabled('false')).toBe(false);
  });

  it('returns false for unsupported values', () => {
    expect(isDebugFlagEnabled('1')).toBe(false);
    expect(isDebugFlagEnabled('TRUE')).toBe(false);
    expect(isDebugFlagEnabled(undefined)).toBe(false);
  });
});
