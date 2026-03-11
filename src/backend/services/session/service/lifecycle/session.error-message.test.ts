import { describe, expect, it, vi } from 'vitest';
import { toErrorMessage } from './session.error-message';

describe('toErrorMessage', () => {
  it('returns Error messages directly', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-null objects', () => {
    expect(toErrorMessage({ reason: 'boom' })).toBe('{"reason":"boom"}');
  });

  it('does not call JSON.stringify for null values', () => {
    const originalStringify = JSON.stringify;
    const stringifySpy = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
        const [value] = args;
        if (value === null) {
          throw new Error('null should not be stringified');
        }
        return originalStringify(...args);
      });

    expect(toErrorMessage(null)).toBe('null');
    expect(stringifySpy).not.toHaveBeenCalled();
  });
});
