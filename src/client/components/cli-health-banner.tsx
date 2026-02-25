import { AlertTriangle, ExternalLink, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

interface HealthIssue {
  title: string;
  description: string;
  link?: string;
  linkLabel?: string;
  upgradeProvider?: 'CLAUDE' | 'CODEX';
}

interface CliHealthForBanner {
  claude: { isInstalled: boolean; isOutdated?: boolean; version?: string; latestVersion?: string };
  codex: {
    isInstalled: boolean;
    isAuthenticated?: boolean;
    isOutdated?: boolean;
    version?: string;
    latestVersion?: string;
  };
  github: { isInstalled: boolean; isAuthenticated: boolean };
}

export function collectIssues(health: CliHealthForBanner): HealthIssue[] {
  const issues: HealthIssue[] = [];

  if (!health.claude.isInstalled) {
    issues.push({
      title: 'Claude CLI not installed',
      description: 'Install the Claude CLI to enable AI-powered coding sessions.',
      link: 'https://claude.ai/download',
      linkLabel: 'Install',
    });
  } else if (health.claude.isOutdated) {
    issues.push({
      title: 'Claude CLI out of date',
      description: `Installed ${health.claude.version ?? 'unknown'}; latest is ${health.claude.latestVersion ?? 'latest'}.`,
      link: 'https://claude.ai/download',
      linkLabel: 'Upgrade',
      upgradeProvider: 'CLAUDE',
    });
  }

  if (!health.github.isInstalled) {
    issues.push({
      title: 'GitHub CLI not installed',
      description: 'Install the GitHub CLI (gh) to enable PR management features.',
      link: 'https://cli.github.com/',
      linkLabel: 'Install',
    });
  } else if (!health.github.isAuthenticated) {
    issues.push({
      title: 'GitHub CLI not authenticated',
      description: 'Run "gh auth login" in your terminal to authenticate with GitHub.',
    });
  }

  if (health.codex.isInstalled && health.codex.isAuthenticated && health.codex.isOutdated) {
    issues.push({
      title: 'Codex CLI out of date',
      description: `Installed ${health.codex.version ?? 'unknown'}; latest is ${health.codex.latestVersion ?? 'latest'}.`,
      link: 'https://developers.openai.com/codex/app-server/',
      linkLabel: 'Upgrade',
      upgradeProvider: 'CODEX',
    });
  }

  return issues;
}

function renderIssueActions(
  issue: HealthIssue,
  isUpgrading: boolean,
  onUpgrade: (provider: 'CLAUDE' | 'CODEX') => void
) {
  return (
    <>
      {issue.link && (
        <a
          href={issue.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-warning underline hover:text-warning/80"
        >
          {issue.linkLabel ?? 'Install'}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {issue.upgradeProvider && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 border-warning/40 px-2 text-xs text-warning hover:bg-warning/10"
          onClick={() => {
            if (issue.upgradeProvider) {
              onUpgrade(issue.upgradeProvider);
            }
          }}
          disabled={isUpgrading}
        >
          {isUpgrading ? 'Upgrading...' : 'Upgrade now'}
        </Button>
      )}
    </>
  );
}

export function CLIHealthBannerContent({
  issues,
  isRefetching,
  isUpgrading,
  onRecheck,
  onDismiss,
  onUpgrade,
}: {
  issues: HealthIssue[];
  isRefetching: boolean;
  isUpgrading: boolean;
  onRecheck: () => void;
  onDismiss: () => void;
  onUpgrade: (provider: 'CLAUDE' | 'CODEX') => void;
}) {
  return (
    <div className="border-b border-warning/20 bg-warning/10 px-3 py-2 sm:px-4 sm:py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-start gap-2.5 sm:gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning sm:h-5 sm:w-5" />
          <div className="min-w-0 space-y-1.5 sm:space-y-2">
            <p className="text-xs font-medium text-warning-foreground dark:text-warning sm:text-sm">
              Some features require additional setup
            </p>
            <ul className="space-y-1 sm:space-y-1.5">
              {issues.map((issue) => (
                <li
                  key={issue.title}
                  className="text-xs leading-snug text-foreground/85 sm:text-sm"
                >
                  <span className="font-medium">{issue.title}</span>
                  <span className="hidden sm:inline">: {issue.description}</span>
                  <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                    {renderIssueActions(issue, isUpgrading, onUpgrade)}
                  </div>
                  <span className="ml-1.5 hidden items-center gap-2 sm:inline-flex">
                    {renderIssueActions(issue, isUpgrading, onUpgrade)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex items-center gap-1.5 self-end sm:self-start sm:gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRecheck}
            disabled={isRefetching || isUpgrading}
            className="h-7 px-2 text-warning hover:bg-warning/20 sm:h-8"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
            <span className="sr-only sm:not-sr-only sm:ml-1.5">Recheck</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDismiss}
            className="h-7 w-7 text-warning hover:bg-warning/20 sm:h-8 sm:w-8"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Dismiss</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Banner that displays warnings when CLI dependencies are not properly installed.
 * Shows on app launch and can be dismissed (but will reappear on next launch if issues persist).
 */
export function CLIHealthBanner() {
  const [dismissed, setDismissed] = useState(false);
  const utils = trpc.useUtils();
  const upgradeProviderCli = trpc.admin.upgradeProviderCLI.useMutation({
    onSuccess: (result) => {
      toast.success(result.message);
      utils.admin.checkCLIHealth.setData({ forceRefresh: false }, result.health);
      void refetch();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const {
    data: health,
    isLoading,
    refetch,
    isRefetching,
  } = trpc.admin.checkCLIHealth.useQuery(
    { forceRefresh: false },
    {
      // Check on mount, but don't poll - user can manually refresh
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 60_000, // Consider stale after 1 minute
    }
  );

  const issueCount = health ? collectIssues(health).length : 0;

  // Reset dismissed state when health issues appear (or change).
  useEffect(() => {
    if (issueCount > 0) {
      setDismissed(false);
    }
  }, [issueCount]);

  if (isLoading || dismissed || !health) {
    return null;
  }

  const issues = collectIssues(health);

  if (issues.length === 0) {
    return null;
  }

  return (
    <CLIHealthBannerContent
      issues={issues}
      isRefetching={isRefetching}
      isUpgrading={upgradeProviderCli.isPending}
      onRecheck={() => refetch()}
      onDismiss={() => setDismissed(true)}
      onUpgrade={(provider) => upgradeProviderCli.mutate({ provider })}
    />
  );
}
