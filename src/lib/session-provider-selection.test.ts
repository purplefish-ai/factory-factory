import { describe, expect, it } from 'vitest';

import {
  getWorkspaceDefaultOptionLabel,
  resolveEffectiveSessionProvider,
  resolveProviderSelection,
} from './session-provider-selection';

describe('resolveProviderSelection', () => {
  it('falls back to workspace default for invalid values', () => {
    expect(resolveProviderSelection('INVALID')).toBe('WORKSPACE_DEFAULT');
  });
});

describe('resolveEffectiveSessionProvider', () => {
  it('uses explicit workspace provider when present', () => {
    expect(resolveEffectiveSessionProvider('CODEX', 'CLAUDE')).toBe('CODEX');
  });

  it('falls back to user provider when workspace provider is workspace default', () => {
    expect(resolveEffectiveSessionProvider('WORKSPACE_DEFAULT', 'CODEX')).toBe('CODEX');
  });
});

describe('getWorkspaceDefaultOptionLabel', () => {
  it('shows concrete provider for workspace default option', () => {
    expect(getWorkspaceDefaultOptionLabel('WORKSPACE_DEFAULT', 'CLAUDE')).toBe(
      'Claude (Workspace Default)'
    );
    expect(getWorkspaceDefaultOptionLabel('CODEX', 'CLAUDE')).toBe('Codex (Workspace Default)');
  });
});
