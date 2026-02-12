import { describe, expect, it } from 'vitest';
import { asConcreteWorkspaceProvider } from './provider-selection';

describe('asConcreteWorkspaceProvider', () => {
  it('returns null when selection is missing', () => {
    expect(asConcreteWorkspaceProvider(undefined)).toBeNull();
    expect(asConcreteWorkspaceProvider(null)).toBeNull();
  });

  it('returns null when workspace defers to default', () => {
    expect(asConcreteWorkspaceProvider('WORKSPACE_DEFAULT')).toBeNull();
  });

  it('returns explicit providers', () => {
    expect(asConcreteWorkspaceProvider('CLAUDE')).toBe('CLAUDE');
    expect(asConcreteWorkspaceProvider('CODEX')).toBe('CODEX');
  });
});
