import { AlertTriangle, ExternalLink, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/frontend/lib/trpc';

/**
 * Banner that displays warnings when CLI dependencies are not properly installed.
 * Shows on app launch and can be dismissed (but will reappear on next launch if issues persist).
 */
export function CLIHealthBanner() {
  const [dismissed, setDismissed] = useState(false);

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

  // Reset dismissed state when health status changes to show new issues
  const allHealthy = health?.allHealthy;
  useEffect(() => {
    if (allHealthy === false) {
      // Only reset if there are issues
      setDismissed(false);
    }
  }, [allHealthy]);

  if (isLoading || dismissed || !health || health.allHealthy) {
    return null;
  }

  const issues: Array<{ title: string; description: string; link?: string }> = [];

  if (!health.claude.isInstalled) {
    issues.push({
      title: 'Claude CLI not installed',
      description: 'Install the Claude CLI to enable AI-powered coding sessions.',
      link: 'https://claude.ai/download',
    });
  }

  if (!health.github.isInstalled) {
    issues.push({
      title: 'GitHub CLI not installed',
      description: 'Install the GitHub CLI (gh) to enable PR management features.',
      link: 'https://cli.github.com/',
    });
  } else if (!health.github.isAuthenticated) {
    issues.push({
      title: 'GitHub CLI not authenticated',
      description: 'Run "gh auth login" in your terminal to authenticate with GitHub.',
    });
  }

  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-yellow-500/20 bg-yellow-500/10 px-4 py-3">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-yellow-600 dark:text-yellow-500" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                Some features require additional setup
              </p>
              <ul className="space-y-1.5">
                {issues.map((issue) => (
                  <li key={issue.title} className="text-sm text-yellow-700 dark:text-yellow-300">
                    <span className="font-medium">{issue.title}:</span> {issue.description}
                    {issue.link && (
                      <a
                        href={issue.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 inline-flex items-center gap-1 text-yellow-800 underline hover:text-yellow-900 dark:text-yellow-200 dark:hover:text-yellow-100"
                      >
                        Install
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isRefetching}
              className="h-8 text-yellow-700 hover:bg-yellow-500/20 hover:text-yellow-800 dark:text-yellow-300 dark:hover:text-yellow-200"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
              Recheck
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDismissed(true)}
              className="h-8 w-8 text-yellow-700 hover:bg-yellow-500/20 hover:text-yellow-800 dark:text-yellow-300 dark:hover:text-yellow-200"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Dismiss</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
