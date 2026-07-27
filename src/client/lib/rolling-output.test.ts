import { describe, expect, it } from 'vitest';
import { appendToRollingOutput, RollingOutputBuffer, trimRollingOutput } from './rolling-output';

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

describe('RollingOutputBuffer', () => {
  it('retains chunks without materializing a truncation marker below the cap', () => {
    const buffer = new RollingOutputBuffer(options);

    buffer.append('abc');
    buffer.append('def');

    expect(buffer.toString()).toBe('abcdef');
  });

  it('retains the newest body with exactly one marker across later appends', () => {
    const buffer = new RollingOutputBuffer(options);

    buffer.append('abcdef');
    buffer.append('ghijklmnop');
    expect(buffer.toString()).toBe('[cut]\nklmnop');

    buffer.append('qrst');
    expect(buffer.toString()).toBe('[cut]\nopqrst');
  });

  it('bounds a single oversized chunk without retaining its discarded prefix', () => {
    const buffer = new RollingOutputBuffer(options);

    buffer.append('abcdefghijklmnop');

    expect(buffer.toString()).toBe('[cut]\nklmnop');
  });

  it('bounds the marker itself when it consumes the entire capacity', () => {
    const buffer = new RollingOutputBuffer({
      maxChars: 4,
      truncationMarker: '[cut]\n',
    });

    buffer.append('abcdef');

    expect(buffer.toString()).toBe('[cut');
  });

  it('retains no chunks when capacity is non-positive', () => {
    const buffer = new RollingOutputBuffer({
      maxChars: 0,
      truncationMarker: '[cut]\n',
    });

    buffer.append('abcdef');

    expect(buffer.toString()).toBe('');
  });

  it('releases strings from consumed chunk slots', () => {
    const buffer = new RollingOutputBuffer(options);

    for (let index = 0; index < 63; index += 1) {
      buffer.append(String(index).padEnd(options.maxChars, 'x'));
    }

    const chunks = Reflect.get(buffer, 'chunks');
    expect(Array.isArray(chunks)).toBe(true);
    const retainedCharacters = Array.isArray(chunks)
      ? chunks.reduce((total, chunk) => total + (typeof chunk === 'string' ? chunk.length : 0), 0)
      : 0;
    expect(retainedCharacters).toBeLessThanOrEqual(options.maxChars);
  });
});
