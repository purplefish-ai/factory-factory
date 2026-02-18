import { describe, expect, it } from 'vitest';
import { encodeGitHubTreeRef } from './github-branch-url';

describe('encodeGitHubTreeRef', () => {
  it('preserves slash separators for branch segments', () => {
    expect(encodeGitHubTreeRef('feature/session-hydration')).toBe('feature/session-hydration');
  });

  it('encodes reserved characters in each segment', () => {
    expect(encodeGitHubTreeRef('feature/space and #hash')).toBe('feature/space%20and%20%23hash');
  });
});
