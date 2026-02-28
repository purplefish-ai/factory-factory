export type SessionProviderValue = 'CLAUDE' | 'CODEX' | 'OPENCODE';
export type NewSessionProviderSelection = SessionProviderValue | 'WORKSPACE_DEFAULT';

export const EXPLICIT_SESSION_PROVIDER_OPTIONS = [
  { value: 'CLAUDE', label: 'Claude' },
  { value: 'CODEX', label: 'Codex' },
  { value: 'OPENCODE', label: 'Opencode' },
] as const;

export function resolveProviderSelection(value: unknown): NewSessionProviderSelection {
  if (
    value === 'CLAUDE' ||
    value === 'CODEX' ||
    value === 'OPENCODE' ||
    value === 'WORKSPACE_DEFAULT'
  ) {
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
  if (
    workspaceDefaultProvider === 'CLAUDE' ||
    workspaceDefaultProvider === 'CODEX' ||
    workspaceDefaultProvider === 'OPENCODE'
  ) {
    return workspaceDefaultProvider;
  }
  if (userDefaultProvider === 'CODEX' || userDefaultProvider === 'OPENCODE') {
    return userDefaultProvider;
  }
  return 'CLAUDE';
}

export function getSessionProviderLabel(provider: SessionProviderValue): string {
  if (provider === 'CODEX') {
    return 'Codex';
  }
  if (provider === 'OPENCODE') {
    return 'Opencode';
  }
  return 'Claude';
}

export function getWorkspaceDefaultOptionLabel(
  workspaceDefaultProvider: unknown,
  userDefaultProvider: unknown
): string {
  const effectiveProvider = resolveEffectiveSessionProvider(
    workspaceDefaultProvider,
    userDefaultProvider
  );
  return `${getSessionProviderLabel(effectiveProvider)} (Workspace Default)`;
}
