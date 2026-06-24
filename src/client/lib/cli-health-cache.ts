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

function getAllHealthy(health: CLIHealthStatus) {
  return (
    health.claude.isInstalled &&
    health.claude.isAuthenticated === true &&
    health.github.isInstalled &&
    health.github.isAuthenticated
  );
}

function createFallbackHealth(github: GitHubCLIHealthStatus): CLIHealthStatus {
  return {
    claude: { isInstalled: true, isAuthenticated: true },
    codex: { isInstalled: true, isAuthenticated: true },
    github,
    allHealthy: false,
  };
}

function patchGitHubHealth(
  current: CLIHealthStatus,
  github: GitHubCLIHealthStatus
): CLIHealthStatus {
  const patched = {
    ...current,
    github,
  };

  return {
    ...patched,
    allHealthy: getAllHealthy(patched),
  };
}

export function syncGitHubCLIHealth(
  checkCLIHealth: CheckCLIHealthUtils,
  github: GitHubCLIHealthStatus
) {
  let patchedExistingCache = false;

  checkCLIHealth.setData({ forceRefresh: false }, (current) => {
    if (!current) {
      return current;
    }

    patchedExistingCache = true;
    return patchGitHubHealth(current, github);
  });

  if (patchedExistingCache) {
    return;
  }

  void checkCLIHealth
    .fetch({ forceRefresh: true })
    .then((freshHealth) => {
      checkCLIHealth.setData({ forceRefresh: false }, () => patchGitHubHealth(freshHealth, github));
    })
    .catch(() => {
      checkCLIHealth.setData({ forceRefresh: false }, (current) =>
        patchGitHubHealth(current ?? createFallbackHealth(github), github)
      );
      void checkCLIHealth.invalidate();
    });
}
