import { describe, expect, it, vi } from 'vitest';
import {
  shouldSyncGitHubCLIHealthFromIssuesResponse,
  syncGitHubCLIHealth,
} from './cli-health-cache';

type CheckCLIHealthUtils = Parameters<typeof syncGitHubCLIHealth>[0];
type CLIHealth = Awaited<ReturnType<CheckCLIHealthUtils['fetch']>>;
type GitHubHealth = Parameters<typeof syncGitHubCLIHealth>[1];

const healthyCLIHealth: CLIHealth = {
  claude: { isInstalled: true, isAuthenticated: true },
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

describe('syncGitHubCLIHealth', () => {
  it('patches an existing CLI health cache entry immediately', () => {
    const { checkCLIHealth, getCurrent, fetch } = createCheckCLIHealthUtils(healthyCLIHealth);

    syncGitHubCLIHealth(checkCLIHealth, unauthenticatedGitHubHealth);

    expect(getCurrent()).toEqual({
      ...healthyCLIHealth,
      github: unauthenticatedGitHubHealth,
      allHealthy: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears a previous GitHub auth warning when issue fetches recover', () => {
    const { checkCLIHealth, getCurrent } = createCheckCLIHealthUtils({
      ...healthyCLIHealth,
      github: unauthenticatedGitHubHealth,
      allHealthy: false,
    });

    syncGitHubCLIHealth(checkCLIHealth, {
      isInstalled: true,
      isAuthenticated: true,
    });

    expect(getCurrent()).toEqual(healthyCLIHealth);
  });

  it('force-refreshes full CLI health before writing when the cache is missing', async () => {
    const { checkCLIHealth, getCurrent, fetch } = createCheckCLIHealthUtils(undefined);

    syncGitHubCLIHealth(checkCLIHealth, unauthenticatedGitHubHealth);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith({ forceRefresh: true }));

    expect(getCurrent()).toEqual({
      ...healthyCLIHealth,
      github: unauthenticatedGitHubHealth,
      allHealthy: false,
    });
  });

  it('invalidates the health query when the fallback refresh fails', async () => {
    const { checkCLIHealth, fetch, getCurrent, invalidate } = createCheckCLIHealthUtils(undefined);
    fetch.mockRejectedValueOnce(new Error('failed'));

    syncGitHubCLIHealth(checkCLIHealth, unauthenticatedGitHubHealth);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());

    expect(getCurrent()).toEqual({
      claude: { isInstalled: true, isAuthenticated: true },
      codex: { isInstalled: true, isAuthenticated: true },
      github: unauthenticatedGitHubHealth,
      allHealthy: false,
    });
  });
});

describe('shouldSyncGitHubCLIHealthFromIssuesResponse', () => {
  it('syncs explicit unauthenticated health even when the issues response has an error', () => {
    expect(
      shouldSyncGitHubCLIHealthFromIssuesResponse(
        unauthenticatedGitHubHealth,
        'GitHub CLI authentication failed'
      )
    ).toBe(true);
  });

  it('syncs authenticated health only after issues fetch successfully', () => {
    const authenticatedHealth: GitHubHealth = {
      isInstalled: true,
      isAuthenticated: true,
    };

    expect(shouldSyncGitHubCLIHealthFromIssuesResponse(authenticatedHealth, null)).toBe(true);
    expect(
      shouldSyncGitHubCLIHealthFromIssuesResponse(authenticatedHealth, 'Failed to fetch issues')
    ).toBe(false);
  });
});
