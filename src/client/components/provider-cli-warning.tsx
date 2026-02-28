import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

const PROVIDER_INFO = {
  CLAUDE: {
    label: 'Claude',
    installUrl: 'https://claude.ai/download',
  },
  CODEX: {
    label: 'Codex',
    installUrl: 'https://developers.openai.com/codex/app-server/',
  },
  OPENCODE: {
    label: 'Opencode',
    installUrl: 'https://opencode.ai',
  },
} as const;

type Provider = 'CLAUDE' | 'CODEX' | 'OPENCODE';
type ProviderWarning = {
  title: string;
  description: string;
  linkLabel?: string;
  linkUrl?: string;
  canUpgrade?: boolean;
};

type ProviderHealth = {
  claude: {
    isInstalled: boolean;
    version?: string;
    latestVersion?: string;
    isOutdated?: boolean;
  };
  codex: {
    isInstalled: boolean;
    isAuthenticated?: boolean;
    version?: string;
    latestVersion?: string;
    isOutdated?: boolean;
  };
  opencode?: {
    isInstalled: boolean;
    isAuthenticated?: boolean;
    version?: string;
    latestVersion?: string;
    isOutdated?: boolean;
  };
};

function buildInstallWarning(provider: Provider): ProviderWarning {
  const info = PROVIDER_INFO[provider];
  return {
    title: `${info.label} CLI is not installed`,
    description: `Install the ${info.label} CLI to use this provider.`,
    linkLabel: 'Install',
    linkUrl: info.installUrl,
  };
}

function buildOutdatedWarning(
  provider: Provider,
  version?: string,
  latestVersion?: string
): ProviderWarning {
  const info = PROVIDER_INFO[provider];
  const installed = version ?? 'unknown';
  const latest = latestVersion ?? 'latest';
  return {
    title: `${info.label} CLI is out of date`,
    description: `Installed ${installed}; latest is ${latest}. Upgrade to avoid compatibility issues.`,
    linkLabel: 'Upgrade',
    linkUrl: info.installUrl,
    canUpgrade: true,
  };
}

function getClaudeWarning(health: ProviderHealth): ProviderWarning | null {
  if (!health.claude.isInstalled) {
    return buildInstallWarning('CLAUDE');
  }
  if (health.claude.isOutdated) {
    return buildOutdatedWarning('CLAUDE', health.claude.version, health.claude.latestVersion);
  }
  return null;
}

function getCodexWarning(health: ProviderHealth): ProviderWarning | null {
  if (!health.codex.isInstalled) {
    return buildInstallWarning('CODEX');
  }
  if (health.codex.isAuthenticated === false) {
    return {
      title: 'Codex CLI is not authenticated',
      description: 'Run `codex login` in your terminal to authenticate.',
    };
  }
  if (health.codex.isOutdated) {
    return buildOutdatedWarning('CODEX', health.codex.version, health.codex.latestVersion);
  }
  return null;
}

function getOpencodeWarning(health: ProviderHealth): ProviderWarning | null {
  const opencode = health.opencode;
  if (!opencode?.isInstalled) {
    return buildInstallWarning('OPENCODE');
  }
  if (opencode.isAuthenticated === false) {
    return {
      title: 'Opencode CLI is not authenticated',
      description: 'Run `opencode auth login` in your terminal to authenticate.',
    };
  }
  if (opencode.isOutdated) {
    return buildOutdatedWarning('OPENCODE', opencode.version, opencode.latestVersion);
  }
  return null;
}

const PROVIDER_WARNING_RESOLVERS = {
  CLAUDE: getClaudeWarning,
  CODEX: getCodexWarning,
  OPENCODE: getOpencodeWarning,
} as const;

function getWarning(provider: Provider, health: ProviderHealth): ProviderWarning | null {
  return PROVIDER_WARNING_RESOLVERS[provider](health);
}

/**
 * Inline warning shown below a provider select when the selected provider's CLI
 * is not installed or not authenticated.
 * Shares the checkCLIHealth query cache with CLIHealthBanner.
 */
export function ProviderCliWarning({ provider }: { provider: 'CLAUDE' | 'CODEX' | 'OPENCODE' }) {
  const utils = trpc.useUtils();
  const upgradeProviderCli = trpc.admin.upgradeProviderCLI.useMutation({
    onSuccess: (result) => {
      toast.success(result.message);
      utils.admin.checkCLIHealth.setData({ forceRefresh: false }, result.health);
      void utils.admin.checkCLIHealth.invalidate();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  const { data: health, isRefetching } = trpc.admin.checkCLIHealth.useQuery(
    { forceRefresh: false },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 60_000,
    }
  );

  if (!health) {
    return null;
  }

  const warning = getWarning(provider, health);
  if (!warning) {
    return null;
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-900/20">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 space-y-1">
        <p className="text-amber-900 dark:text-amber-200">{warning.title}</p>
        <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
          {warning.description}
          {warning.linkUrl && (
            <>
              {' '}
              <a
                href={warning.linkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 underline"
              >
                {warning.linkLabel}
                <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
        </p>
      </div>
      {warning.canUpgrade && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 border-amber-500/60 px-2 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
          onClick={() => upgradeProviderCli.mutate({ provider })}
          disabled={isRefetching || upgradeProviderCli.isPending}
        >
          {upgradeProviderCli.isPending ? 'Upgrading...' : 'Upgrade'}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/40"
        onClick={() => utils.admin.checkCLIHealth.invalidate()}
        disabled={isRefetching || upgradeProviderCli.isPending}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
        <span className="sr-only">Recheck</span>
      </Button>
    </div>
  );
}
