import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import type { CodexAccountSummary } from '@/shared/codex-accounts';

function getWarning(
  provider: 'CLAUDE' | 'CODEX',
  health: {
    claude: {
      isInstalled: boolean;
      isAuthenticated?: boolean;
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
} | null {
  if (provider === 'CLAUDE') {
    if (!health.claude.isInstalled) {
      return {
        title: 'Claude runtime is unavailable',
        description: 'Update or reinstall Factory Factory to restore its bundled Claude runtime.',
      };
    }
    if (health.claude.isAuthenticated === false) {
      return {
        title: 'Claude is not authenticated',
        description:
          'Open the setup terminal in Settings and choose Sign in to Claude. If ff is installed, run `ff claude auth login`.',
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
      description:
        'Open the setup terminal in Settings and choose Sign in to Codex. If ff is installed, run `ff codex login`.',
    };
  }
  return null;
}

function getAccountWarning(
  provider: 'CLAUDE' | 'CODEX',
  account?: Pick<CodexAccountSummary, 'kind' | 'authenticated'>
): ReturnType<typeof getWarning> {
  if (provider !== 'CODEX' || account?.authenticated !== false) {
    return null;
  }
  return {
    title: 'Codex account is not authenticated',
    description:
      account.kind === 'MANAGED'
        ? 'Sign in to this account from Settings.'
        : 'Open the setup terminal in Settings and choose Sign in to Codex. If ff is installed, run `ff codex login`.',
  };
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
  const { data: health, isRefetching } = trpc.admin.checkCLIHealth.useQuery(
    { forceRefresh: false },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 60_000,
    }
  );

  const { data: accounts } = trpc.codexAccounts.list.useQuery(undefined, {
    enabled: provider === 'CODEX' && (!!codexAccountId || health?.codex.isAuthenticated === false),
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

  const selectedAccount = codexAccountId
    ? accounts?.find((account) => account.id === codexAccountId)
    : undefined;
  const warning =
    getWarning(provider, health, hasUsableCodexAccount || !!selectedAccount) ??
    getAccountWarning(provider, selectedAccount);

  if (!warning) {
    return null;
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-900/20">
      <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 space-y-1">
        <p className="text-amber-900 dark:text-amber-200">{warning.title}</p>
        <p className="text-xs text-amber-800/80 dark:text-amber-300/80">{warning.description}</p>
      </div>
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
        disabled={isRefetching}
      >
        <ArrowsClockwiseIcon className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
        <span className="sr-only">Recheck</span>
      </Button>
    </div>
  );
}
