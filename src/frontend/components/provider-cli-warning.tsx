import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/frontend/lib/trpc';

const PROVIDER_INFO = {
  CLAUDE: {
    label: 'Claude',
    installUrl: 'https://claude.ai/download',
  },
  CODEX: {
    label: 'Codex',
    installUrl: 'https://developers.openai.com/codex/app-server/',
  },
} as const;

function getWarning(
  provider: 'CLAUDE' | 'CODEX',
  health: {
    claude: { isInstalled: boolean };
    codex: { isInstalled: boolean; isAuthenticated?: boolean };
  }
): { title: string; description: string; linkLabel?: string; linkUrl?: string } | null {
  const info = PROVIDER_INFO[provider];

  if (provider === 'CLAUDE') {
    if (!health.claude.isInstalled) {
      return {
        title: `${info.label} CLI is not installed`,
        description: `Install the ${info.label} CLI to use this provider.`,
        linkLabel: 'Install',
        linkUrl: info.installUrl,
      };
    }
    return null;
  }

  // Codex
  if (!health.codex.isInstalled) {
    return {
      title: `${info.label} CLI is not installed`,
      description: `Install the ${info.label} CLI to use this provider.`,
      linkLabel: 'Install',
      linkUrl: info.installUrl,
    };
  }
  if (health.codex.isAuthenticated === false) {
    return {
      title: `${info.label} CLI is not authenticated`,
      description: 'Run `codex login` in your terminal to authenticate.',
    };
  }
  return null;
}

/**
 * Inline warning shown below a provider select when the selected provider's CLI
 * is not installed or not authenticated.
 * Shares the checkCLIHealth query cache with CLIHealthBanner.
 */
export function ProviderCliWarning({ provider }: { provider: 'CLAUDE' | 'CODEX' }) {
  const utils = trpc.useUtils();
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
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-amber-600 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/40"
        onClick={() => utils.admin.checkCLIHealth.invalidate()}
        disabled={isRefetching}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
        <span className="sr-only">Recheck</span>
      </Button>
    </div>
  );
}
