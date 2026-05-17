import { describe, expect, it, vi } from 'vitest';
import { toErrorMessage } from './session.error-message';

describe('toErrorMessage', () => {
  it('returns Error messages directly', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('summarizes structured non-null objects without stringifying them', () => {
    expect(toErrorMessage({ reason: 'boom' })).toBe('boom');
    expect(
      toErrorMessage({
        code: -32_600,
        message: 'Invalid request',
        data: { reason: 'A turn is already in progress for this session' },
      })
    ).toBe('code -32600: Invalid request: A turn is already in progress for this session');
  });

  it('does not call JSON.stringify for null values or objects', () => {
    const originalStringify = JSON.stringify;
    const stringifySpy = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
        const [value] = args;
        if (value === null || (typeof value === 'object' && value !== null)) {
          throw new Error('objects should not be stringified');
        }
        return originalStringify(...args);
      });

    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage({ reason: 'boom' })).toBe('boom');
    expect(stringifySpy).not.toHaveBeenCalled();
  });
});
