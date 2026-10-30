import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useEffect, useState } from 'react';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

const CLI_HEALTH_WARNING_DISMISSED_KEY = 'ff_cli_health_warning_dismissed';

export interface HealthIssue {
  title: string;
  description: string;
  link?: string;
  linkLabel?: string;
}

interface CliHealthForBanner {
  claude: {
    isInstalled: boolean;
    isAuthenticated?: boolean;
    isOutdated?: boolean;
    version?: string;
    latestVersion?: string;
  };
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
      title: 'Claude runtime unavailable',
      description: 'Update or reinstall Factory Factory to restore its bundled Claude runtime.',
    });
  } else if (health.claude.isAuthenticated === false) {
    issues.push({
      title: 'Claude sign-in required',
      description: 'Run "ff claude auth login" in your terminal to authenticate.',
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
      title: 'GitHub sign-in required',
      description:
        'Run "gh auth refresh -h github.com" or "gh auth login" in your terminal to authenticate with GitHub.',
    });
  }

  return issues;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getCLIHealthWarningFingerprint(issues: HealthIssue[]): string {
  return JSON.stringify(
    issues.map((issue) => ({
      title: issue.title,
      description: issue.description,
      link: issue.link ?? null,
      linkLabel: issue.linkLabel ?? null,
    }))
  );
}

export function readDismissedCLIHealthWarningFingerprint(): string | null {
  try {
    return getStorage()?.getItem(CLI_HEALTH_WARNING_DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function isCLIHealthWarningDismissed(fingerprint: string): boolean {
  return readDismissedCLIHealthWarningFingerprint() === fingerprint;
}

export function rememberDismissedCLIHealthWarning(fingerprint: string) {
  try {
    getStorage()?.setItem(CLI_HEALTH_WARNING_DISMISSED_KEY, fingerprint);
  } catch {
    // Non-blocking: ignore localStorage failures.
  }
}

export function forgetDismissedCLIHealthWarning() {
  try {
    getStorage()?.removeItem(CLI_HEALTH_WARNING_DISMISSED_KEY);
  } catch {
    // Non-blocking: ignore localStorage failures.
  }
}

export function CLIHealthBannerContent({
  issues,
  isRefetching,
  onRecheck,
  onDismiss,
}: {
  issues: HealthIssue[];
  isRefetching: boolean;
  onRecheck: () => void;
  onDismiss: () => void;
}) {
  if (issues.length === 0) {
    return null;
  }

  const warnings = issues;
  const isBusy = isRefetching;

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {warnings.length > 0 && (
          <ul className="min-w-0 flex-1 basis-full space-y-2 sm:basis-0">
            {warnings.map((issue) => (
              <li key={issue.title} className="flex items-start gap-2 text-xs">
                <WarningIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div role="alert" className="min-w-0 space-y-0.5">
                  <p className="font-medium text-amber-800 dark:text-amber-300">{issue.title}</p>
                  <p className="text-muted-foreground [overflow-wrap:anywhere]">
                    {issue.description}
                    {issue.link && (
                      <a
                        href={issue.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
                      >
                        {issue.linkLabel ?? 'Install'}
                        <ArrowSquareOutIcon className="size-3" />
                      </a>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {warnings.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRecheck}
              disabled={isBusy}
              className="text-muted-foreground"
            >
              <ArrowsClockwiseIcon className={`size-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
              Recheck
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            className="text-muted-foreground"
          >
            <XIcon className="size-4" />
            <span className="sr-only">Dismiss</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact setup warnings for managed runtimes and CLI dependencies.
 * Shows on app launch and can be dismissed until the warning content changes.
 */
export function CLIHealthBanner() {
  const [dismissedFingerprint, setDismissedFingerprint] = useState(() =>
    readDismissedCLIHealthWarningFingerprint()
  );
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

  const issues = health ? collectIssues(health) : [];
  const warningFingerprint = issues.length > 0 ? getCLIHealthWarningFingerprint(issues) : null;

  useEffect(() => {
    if (health && issues.length === 0) {
      forgetDismissedCLIHealthWarning();
      if (dismissedFingerprint !== null) {
        setDismissedFingerprint(null);
      }
    }
  }, [dismissedFingerprint, health, issues.length]);

  if (isLoading || !health) {
    return null;
  }

  if (
    !warningFingerprint ||
    dismissedFingerprint === warningFingerprint ||
    isCLIHealthWarningDismissed(warningFingerprint)
  ) {
    return null;
  }

  return (
    <CLIHealthBannerContent
      issues={issues}
      isRefetching={isRefetching}
      onRecheck={() => {
        runInBackground(refetch({ throwOnError: true }), 'Could not check provider status');
      }}
      onDismiss={() => {
        rememberDismissedCLIHealthWarning(warningFingerprint);
        setDismissedFingerprint(warningFingerprint);
      }}
    />
  );
}
