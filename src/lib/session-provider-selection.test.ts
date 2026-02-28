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

  it('accepts OPENCODE as explicit provider', () => {
    expect(resolveProviderSelection('OPENCODE')).toBe('OPENCODE');
  });
});

describe('resolveEffectiveSessionProvider', () => {
  it('uses explicit workspace provider when present', () => {
    expect(resolveEffectiveSessionProvider('CODEX', 'CLAUDE')).toBe('CODEX');
  });

  it('falls back to user provider when workspace provider is workspace default', () => {
    expect(resolveEffectiveSessionProvider('WORKSPACE_DEFAULT', 'CODEX')).toBe('CODEX');
  });

  it('resolves OPENCODE user default when workspace provider is workspace default', () => {
    expect(resolveEffectiveSessionProvider('WORKSPACE_DEFAULT', 'OPENCODE')).toBe('OPENCODE');
  });
});

describe('getWorkspaceDefaultOptionLabel', () => {
  it('shows concrete provider for workspace default option', () => {
    expect(getWorkspaceDefaultOptionLabel('WORKSPACE_DEFAULT', 'CLAUDE')).toBe(
      'Claude (Workspace Default)'
    );
    expect(getWorkspaceDefaultOptionLabel('CODEX', 'CLAUDE')).toBe('Codex (Workspace Default)');
    expect(getWorkspaceDefaultOptionLabel('OPENCODE', 'CLAUDE')).toBe(
      'Opencode (Workspace Default)'
    );
  });

  it('falls back to Claude when user default provider is missing', () => {
    expect(getWorkspaceDefaultOptionLabel('WORKSPACE_DEFAULT', undefined)).toBe(
      'Claude (Workspace Default)'
    );
    expect(getWorkspaceDefaultOptionLabel('WORKSPACE_DEFAULT', null)).toBe(
      'Claude (Workspace Default)'
    );
  });
});
