import { describe, expect, it } from 'vitest';
import { toError } from './error-utils';

describe('toError', () => {
  it('returns the original Error instance', () => {
    const original = new TypeError('boom');

    expect(toError(original)).toBe(original);
  });

  it('wraps non-Error values in Error', () => {
    const actual = toError({ code: 42 });

    expect(actual).toBeInstanceOf(Error);
    expect(actual.message).toBe('[object Object]');
  });

  it('stringifies null and undefined values', () => {
    expect(toError(null).message).toBe('null');
    expect(toError(undefined).message).toBe('undefined');
  });
});
