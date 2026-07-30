import { describe, expect, it, vi } from 'vitest';
import {
  toErrorMessage,
  toProviderFailureChatMessage,
  toPublicProviderErrorMessage,
} from './session.error-message';

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
        if (value == null || typeof value === 'object') {
          throw new Error('objects should not be stringified');
        }
        return originalStringify(...args);
      });

    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage({ reason: 'boom' })).toBe('boom');
    expect(stringifySpy).not.toHaveBeenCalled();
  });
});

describe('provider failure messages', () => {
  it.each([
    ['  HTTP 529:   Overloaded  ', 'HTTP 529 (Overloaded)'],
    ['HTTP 500 opaque upstream detail', 'HTTP 500'],
    ['request failed: secret-token=abc', 'The provider returned an error.'],
    ['request failed: api_key=abc', 'The provider returned an error.'],
    ['ghp_1234567890abcdefghijklmnopqrstuvwxyz', 'The provider returned an error.'],
    ['sk-proj-1234567890abcdefghijklmnopqrstuvwxyz', 'The provider returned an error.'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
      'The provider returned an error.',
    ],
    ['https://martin:supersecret@example.com/api', 'The provider returned an error.'],
    [
      '/Users/martin/private/prompt.txt: failed on customer@example.com',
      'The provider returned an error.',
    ],
    ['the user asked to publish their private prompt fragment', 'The provider returned an error.'],
  ])('normalizes public provider text', (input, expected) => {
    expect(toPublicProviderErrorMessage(new Error(input))).toBe(expected);
  });

  it('adds the provider name and terminal punctuation', () => {
    expect(toProviderFailureChatMessage('CODEX', new Error('HTTP 529: Overloaded'))).toBe(
      'Turn stopped: Codex returned HTTP 529 (Overloaded).'
    );
  });
});
