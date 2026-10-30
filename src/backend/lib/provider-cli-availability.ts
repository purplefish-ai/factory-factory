import type { SessionProvider } from '@prisma-gen/client';

export interface ProviderCliHealthStatus {
  claude: {
    isInstalled: boolean;
    error?: string;
  };
  codex: {
    isInstalled: boolean;
    isAuthenticated?: boolean;
    error?: string;
  };
}

function getProviderLabel(provider: SessionProvider): string {
  return provider === 'CODEX' ? 'Codex' : 'Claude';
}

export function getProviderBlockingIssue(
  provider: SessionProvider,
  health: ProviderCliHealthStatus,
  options?: { accountScopedCodex?: boolean }
): string | null {
  if (provider === 'CLAUDE') {
    if (!health.claude.isInstalled) {
      return health.claude.error ?? 'Claude CLI is not installed.';
    }
    return null;
  }

  if (!health.codex.isInstalled) {
    return health.codex.error ?? 'Codex CLI is not installed.';
  }
  if (!options?.accountScopedCodex && health.codex.isAuthenticated === false) {
    return health.codex.error ?? 'Codex CLI is not authenticated.';
  }

  return null;
}

export function getProviderUnavailableMessage(
  provider: SessionProvider,
  health: ProviderCliHealthStatus,
  options?: { accountScopedCodex?: boolean }
): string | null {
  const issue = getProviderBlockingIssue(provider, health, options);
  if (!issue) {
    return null;
  }

  return `${getProviderLabel(provider)} provider is unavailable: ${issue}`;
}
