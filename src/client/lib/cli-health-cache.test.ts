import { describe, expect, it, vi } from 'vitest';
import { syncUnauthenticatedGitHubCLIHealth } from './cli-health-cache';

type CheckCLIHealthUtils = Parameters<typeof syncUnauthenticatedGitHubCLIHealth>[0];
type CLIHealth = Awaited<ReturnType<CheckCLIHealthUtils['fetch']>>;
type GitHubHealth = Parameters<typeof syncUnauthenticatedGitHubCLIHealth>[1];

const healthyCLIHealth: CLIHealth = {
  claude: { isInstalled: true },
  codex: { isInstalled: true, isAuthenticated: true },
  github: { isInstalled: true, isAuthenticated: true },
  allHealthy: true,
};

const unauthenticatedGitHubHealth: GitHubHealth = {
  isInstalled: true,
  isAuthenticated: false,
  error: 'GitHub CLI authentication failed',
  errorType: 'auth_required' as const,
};

function createCheckCLIHealthUtils(current: CLIHealth | undefined) {
  const setData: CheckCLIHealthUtils['setData'] = vi.fn((_input, updater) => {
    current = updater(current);
  });
  const fetchMock = vi.fn(async () => healthyCLIHealth);
  const invalidateMock = vi.fn(async () => undefined);
  const checkCLIHealth: CheckCLIHealthUtils = {
    setData,
    fetch: fetchMock,
    invalidate: invalidateMock,
  };

  return {
    checkCLIHealth,
    getCurrent: () => current,
    fetch: fetchMock,
    invalidate: invalidateMock,
  };
}

describe('syncUnauthenticatedGitHubCLIHealth', () => {
  it('patches an existing CLI health cache entry immediately', () => {
    const { checkCLIHealth, getCurrent, fetch } = createCheckCLIHealthUtils(healthyCLIHealth);

    syncUnauthenticatedGitHubCLIHealth(checkCLIHealth, unauthenticatedGitHubHealth);

    expect(getCurrent()).toEqual({
      ...healthyCLIHealth,
      github: unauthenticatedGitHubHealth,
      allHealthy: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('force-refreshes full CLI health before writing when the cache is missing', async () => {
    const { checkCLIHealth, getCurrent, fetch } = createCheckCLIHealthUtils(undefined);

    syncUnauthenticatedGitHubCLIHealth(checkCLIHealth, unauthenticatedGitHubHealth);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith({ forceRefresh: true }));

    expect(getCurrent()).toEqual({
      ...healthyCLIHealth,
      github: unauthenticatedGitHubHealth,
      allHealthy: false,
    });
  });

  it('invalidates the health query when the fallback refresh fails', async () => {
    const { checkCLIHealth, fetch, invalidate } = createCheckCLIHealthUtils(undefined);
    fetch.mockRejectedValueOnce(new Error('failed'));

    syncUnauthenticatedGitHubCLIHealth(checkCLIHealth, unauthenticatedGitHubHealth);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());
  });
});
