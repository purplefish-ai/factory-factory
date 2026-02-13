import { describe, expect, it } from 'vitest';
import { buildHydrateKey } from './session-hydrate-key';

describe('buildHydrateKey', () => {
  it('uses none placeholders for null values', () => {
    expect(
      buildHydrateKey({
        claudeSessionId: null,
        claudeProjectPath: null,
      })
    ).toBe('none::none');
  });

  it('builds key from provided values', () => {
    expect(
      buildHydrateKey({
        claudeSessionId: 'session-123',
        claudeProjectPath: '/tmp/project',
      })
    ).toBe('session-123::/tmp/project');
  });
});
