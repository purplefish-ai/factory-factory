import { describe, expect, it } from 'vitest';
import { shouldIncludeJSONLEntry } from './transcript-policy';

describe('shouldIncludeJSONLEntry', () => {
  it('includes normal entries with a message payload', () => {
    expect(
      shouldIncludeJSONLEntry({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      })
    ).toBe(true);
  });

  it('excludes meta entries', () => {
    expect(
      shouldIncludeJSONLEntry({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'hello' },
      })
    ).toBe(false);
  });

  it('excludes entries without a message payload', () => {
    expect(shouldIncludeJSONLEntry({ type: 'system' })).toBe(false);
  });

  it('includes entries where isMeta is false', () => {
    expect(
      shouldIncludeJSONLEntry({
        type: 'assistant',
        isMeta: false,
        message: { role: 'assistant', content: 'hi' },
      })
    ).toBe(true);
  });

  it('excludes entries with null message', () => {
    expect(shouldIncludeJSONLEntry({ type: 'user', message: null })).toBe(false);
  });

  it('excludes entries with undefined message', () => {
    expect(shouldIncludeJSONLEntry({ type: 'user', message: undefined })).toBe(false);
  });

  it('includes entries with extra passthrough fields', () => {
    expect(
      shouldIncludeJSONLEntry({
        type: 'user',
        timestamp: '2025-01-01T00:00:00Z',
        uuid: 'abc-123',
        gitBranch: 'main',
        message: { role: 'user', content: 'hello' },
      })
    ).toBe(true);
  });
});
