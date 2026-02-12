import { describe, expect, it } from 'vitest';
import {
  type NewSessionProviderSelection,
  resolveExplicitSessionProvider,
} from './use-workspace-detail';

describe('resolveExplicitSessionProvider', () => {
  it('returns undefined when workspace default is selected', () => {
    const selectedProvider: NewSessionProviderSelection = 'WORKSPACE_DEFAULT';
    expect(resolveExplicitSessionProvider(selectedProvider)).toBeUndefined();
  });

  it('returns explicit Claude provider', () => {
    const selectedProvider: NewSessionProviderSelection = 'CLAUDE';
    expect(resolveExplicitSessionProvider(selectedProvider)).toBe('CLAUDE');
  });

  it('returns explicit Codex provider', () => {
    const selectedProvider: NewSessionProviderSelection = 'CODEX';
    expect(resolveExplicitSessionProvider(selectedProvider)).toBe('CODEX');
  });
});
