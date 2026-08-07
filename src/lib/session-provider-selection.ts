export type SessionProviderValue = 'CLAUDE' | 'CODEX' | 'OPENHANDS';
export type NewSessionProviderSelection = SessionProviderValue | 'WORKSPACE_DEFAULT';

export const EXPLICIT_SESSION_PROVIDER_OPTIONS = [
  { value: 'CLAUDE', label: 'Claude' },
  { value: 'CODEX', label: 'Codex' },
  { value: 'OPENHANDS', label: 'OpenHands' },
] as const;

export function resolveProviderSelection(value: unknown): NewSessionProviderSelection {
  if (
    value === 'CLAUDE' ||
    value === 'CODEX' ||
    value === 'OPENHANDS' ||
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
    workspaceDefaultProvider === 'OPENHANDS'
  ) {
    return workspaceDefaultProvider;
  }
  if (userDefaultProvider === 'CODEX') {
    return 'CODEX';
  }
  if (userDefaultProvider === 'OPENHANDS') {
    return 'OPENHANDS';
  }
  return 'CLAUDE';
}

export function getSessionProviderLabel(provider: SessionProviderValue): string {
  switch (provider) {
    case 'CODEX':
      return 'Codex';
    case 'OPENHANDS':
      return 'OpenHands';
    default:
      return 'Claude';
  }
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
