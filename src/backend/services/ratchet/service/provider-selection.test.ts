import { describe, expect, it } from 'vitest';
import { resolveRatchetProviderFromWorkspace } from './provider-selection';

describe('resolveRatchetProviderFromWorkspace', () => {
  it('uses ratchet override when set', () => {
    expect(
      resolveRatchetProviderFromWorkspace({
        ratchetSessionProvider: 'CODEX',
        defaultSessionProvider: 'CLAUDE',
      })
    ).toBe('CODEX');
  });

  it('falls back to workspace default when ratchet uses WORKSPACE_DEFAULT', () => {
    expect(
      resolveRatchetProviderFromWorkspace({
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        defaultSessionProvider: 'CLAUDE',
      })
    ).toBe('CLAUDE');
  });

  it('returns null when both selections defer to user default', () => {
    expect(
      resolveRatchetProviderFromWorkspace({
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
      })
    ).toBeNull();
  });
});
