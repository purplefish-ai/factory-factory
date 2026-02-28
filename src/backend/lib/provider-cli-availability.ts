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
  opencode?: {
    isInstalled: boolean;
    isAuthenticated?: boolean;
    error?: string;
  };
}

function getProviderLabel(provider: SessionProvider): string {
  if (provider === 'CODEX') {
    return 'Codex';
  }
  if (provider === 'OPENCODE') {
    return 'Opencode';
  }
  return 'Claude';
}

export function getProviderBlockingIssue(
  provider: SessionProvider,
  health: ProviderCliHealthStatus
): string | null {
  if (provider === 'CLAUDE') {
    if (!health.claude.isInstalled) {
      return health.claude.error ?? 'Claude CLI is not installed.';
    }
    return null;
  }

  if (provider === 'OPENCODE') {
    const opencodeHealth = health.opencode;
    if (!opencodeHealth?.isInstalled) {
      return opencodeHealth?.error ?? 'Opencode CLI is not installed.';
    }
    if (opencodeHealth.isAuthenticated === false) {
      return opencodeHealth.error ?? 'Opencode CLI is not authenticated.';
    }
    return null;
  }

  if (!health.codex.isInstalled) {
    return health.codex.error ?? 'Codex CLI is not installed.';
  }
  if (health.codex.isAuthenticated === false) {
    return health.codex.error ?? 'Codex CLI is not authenticated.';
  }

  return null;
}

export function getProviderUnavailableMessage(
  provider: SessionProvider,
  health: ProviderCliHealthStatus
): string | null {
  const issue = getProviderBlockingIssue(provider, health);
  if (!issue) {
    return null;
  }

  return `${getProviderLabel(provider)} provider is unavailable: ${issue}`;
}
