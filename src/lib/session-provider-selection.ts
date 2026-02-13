export type SessionProviderValue = 'CLAUDE' | 'CODEX';
export type NewSessionProviderSelection = SessionProviderValue | 'WORKSPACE_DEFAULT';

export const EXPLICIT_SESSION_PROVIDER_OPTIONS = [
  { value: 'CLAUDE', label: 'Claude' },
  { value: 'CODEX', label: 'Codex' },
] as const;

export function resolveProviderSelection(value: unknown): NewSessionProviderSelection {
  if (value === 'CLAUDE' || value === 'CODEX' || value === 'WORKSPACE_DEFAULT') {
    return value;
  }
  return 'WORKSPACE_DEFAULT';
}

export function resolveExplicitSessionProvider(
  selectedProvider: NewSessionProviderSelection
): SessionProviderValue | undefined {
  return selectedProvider === 'WORKSPACE_DEFAULT' ? undefined : selectedProvider;
}

export function resolveEffectiveSessionProvider(
  workspaceDefaultProvider: unknown,
  userDefaultProvider: unknown
): SessionProviderValue {
  if (workspaceDefaultProvider === 'CLAUDE' || workspaceDefaultProvider === 'CODEX') {
    return workspaceDefaultProvider;
  }
  return userDefaultProvider === 'CODEX' ? 'CODEX' : 'CLAUDE';
}

export function getSessionProviderLabel(provider: SessionProviderValue): string {
  return provider === 'CODEX' ? 'Codex' : 'Claude';
}
