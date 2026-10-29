import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

const PROVIDER_INFO = {
  CLAUDE: {
    label: 'Claude',
    installUrl: 'https://claude.ai/download',
  },
} as const;

function getWarning(
  provider: 'CLAUDE' | 'CODEX',
  health: {
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
  },
  hasUsableCodexAccount = false
): {
  title: string;
  description: string;
  linkLabel?: string;
  linkUrl?: string;
  canUpgrade?: boolean;
} | null {
  if (provider === 'CLAUDE') {
    const info = PROVIDER_INFO.CLAUDE;
    if (!health.claude.isInstalled) {
      return {
        title: `${info.label} CLI is not installed`,
        description: `Install the ${info.label} CLI to use this provider.`,
        linkLabel: 'Install',
        linkUrl: info.installUrl,
      };
    }
    if (health.claude.isOutdated) {
      const installed = health.claude.version ?? 'unknown';
      const latest = health.claude.latestVersion ?? 'latest';
      return {
        title: `${info.label} CLI is out of date`,
        description: `Installed ${installed}; latest is ${latest}. Upgrade to avoid compatibility issues.`,
        linkLabel: 'Upgrade',
        linkUrl: info.installUrl,
        canUpgrade: true,
      };
    }
    return null;
  }

  if (!health.codex.isInstalled) {
    return {
      title: 'Codex runtime is unavailable',
      description: 'Update or reinstall Factory Factory to restore its bundled Codex runtime.',
    };
  }
  if (health.codex.isAuthenticated === false && !hasUsableCodexAccount) {
    return {
      title: 'Codex is not authenticated',
      description: 'Run `ff codex login` in your terminal to authenticate.',
    };
  }
  return null;
}

/**
 * Inline warning shown below a provider select when the selected provider's CLI
 * is not installed or not authenticated.
 * Shares the checkCLIHealth query cache with CLIHealthBanner.
 */
export function ProviderCliWarning({
  provider,
  codexAccountId,
}: {
  provider: 'CLAUDE' | 'CODEX';
  codexAccountId?: string;
}) {
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

  const { data: accounts } = trpc.codexAccounts.list.useQuery(undefined, {
    enabled: provider === 'CODEX' && health?.codex.isAuthenticated === false,
    staleTime: 30_000,
    retry: false,
  });
  const hasUsableCodexAccount =
    accounts?.some(
      (account) =>
        account.authenticated && (codexAccountId ? account.id === codexAccountId : account.enabled)
    ) ?? false;
  if (!health) {
    return null;
  }

  const warning = getWarning(provider, health, hasUsableCodexAccount);
  if (!warning) {
    return null;
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-900/20">
      <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
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
                <ArrowSquareOutIcon className="h-3 w-3" />
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
        onClick={() => {
          runInBackground(
            utils.admin.checkCLIHealth.invalidate(),
            'Could not check provider status'
          );
        }}
        disabled={isRefetching || upgradeProviderCli.isPending}
      >
        <ArrowsClockwiseIcon className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
        <span className="sr-only">Recheck</span>
      </Button>
    </div>
  );
}
