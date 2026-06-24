import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type CLIHealthStatus = RouterOutputs['admin']['checkCLIHealth'];
type GitHubCLIHealthStatus = CLIHealthStatus['github'];

interface CheckCLIHealthUtils {
  setData: (
    input: { forceRefresh: boolean },
    updater: (current: CLIHealthStatus | undefined) => CLIHealthStatus | undefined
  ) => void;
  fetch: (input: { forceRefresh: boolean }) => Promise<CLIHealthStatus>;
  invalidate: () => Promise<unknown>;
}

export function syncUnauthenticatedGitHubCLIHealth(
  checkCLIHealth: CheckCLIHealthUtils,
  github: GitHubCLIHealthStatus
) {
  let patchedExistingCache = false;

  checkCLIHealth.setData({ forceRefresh: false }, (current) => {
    if (!current) {
      return current;
    }

    patchedExistingCache = true;
    return {
      ...current,
      github,
      allHealthy: false,
    };
  });

  if (patchedExistingCache) {
    return;
  }

  void checkCLIHealth
    .fetch({ forceRefresh: true })
    .then((freshHealth) => {
      checkCLIHealth.setData({ forceRefresh: false }, () => ({
        ...freshHealth,
        github,
        allHealthy: false,
      }));
    })
    .catch(() => {
      void checkCLIHealth.invalidate();
    });
}
