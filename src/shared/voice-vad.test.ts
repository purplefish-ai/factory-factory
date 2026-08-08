import { describe, expect, it } from 'vitest';
import { deriveAggressivenessLabel } from './voice-vad';

describe('deriveAggressivenessLabel', () => {
  it('labels the bottom third Aggressive', () => {
    expect(deriveAggressivenessLabel(0, 0, 90)).toBe('Aggressive');
    expect(deriveAggressivenessLabel(30, 0, 90)).toBe('Aggressive');
  });

  it('labels the middle third Balanced', () => {
    expect(deriveAggressivenessLabel(31, 0, 90)).toBe('Balanced');
    expect(deriveAggressivenessLabel(60, 0, 90)).toBe('Balanced');
  });

  it('labels the top third Patient', () => {
    expect(deriveAggressivenessLabel(61, 0, 90)).toBe('Patient');
    expect(deriveAggressivenessLabel(90, 0, 90)).toBe('Patient');
  });

  it('is inclusive at the 1/3 and 2/3 boundaries', () => {
    expect(deriveAggressivenessLabel(1 / 3, 0, 1)).toBe('Aggressive');
    expect(deriveAggressivenessLabel(2 / 3, 0, 1)).toBe('Balanced');
  });
});
