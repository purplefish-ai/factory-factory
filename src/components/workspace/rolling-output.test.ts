import { describe, expect, it } from 'vitest';
import { appendToRollingOutput, trimRollingOutput } from './rolling-output';

const options = {
  maxChars: 12,
  truncationMarker: '[cut]\n',
};

describe('rolling output', () => {
  it('appends without a marker while output is below the cap', () => {
    expect(appendToRollingOutput('abc', 'def', options)).toBe('abcdef');
  });

  it('keeps only the newest output and prepends one truncation marker', () => {
    expect(appendToRollingOutput('abcdef', 'ghijklmnop', options)).toBe('[cut]\nklmnop');
  });

  it('does not duplicate the truncation marker on later appends', () => {
    const truncated = appendToRollingOutput('abcdef', 'ghijklmnop', options);

    expect(appendToRollingOutput(truncated, 'qrst', options)).toBe('[cut]\nopqrst');
  });

  it('trims restored output with the same bounded representation', () => {
    expect(trimRollingOutput('abcdefghijklmnop', options)).toBe('[cut]\nklmnop');
  });

  it('does not exceed the cap when the truncation marker is longer than the cap', () => {
    expect(
      appendToRollingOutput('abc', 'def', {
        maxChars: 4,
        truncationMarker: '[cut]\n',
      })
    ).toBe('[cut');
  });

  it('returns an empty string for a non-positive cap', () => {
    expect(
      appendToRollingOutput('abc', 'def', {
        maxChars: 0,
        truncationMarker: '[cut]\n',
      })
    ).toBe('');
  });
});
