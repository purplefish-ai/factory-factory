import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { OnboardingCliHealth } from './onboarding-cli-health';

vi.mock('@/client/hooks/use-cli-health-refresh', () => ({
  useCLIHealthRefresh: () => ({ refresh: vi.fn(), isRefreshing: false }),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      checkCLIHealth: {
        useQuery: () => ({
          data: {
            claude: { isInstalled: true, isAuthenticated: true },
            codex: {
              isInstalled: false,
              isAuthenticated: false,
              error:
                'Please try again in a few moments. If this continues, try restarting Factory Factory.',
            },
            github: { isInstalled: true, isAuthenticated: true },
          },
          isLoading: false,
          isRefetching: false,
        }),
      },
    },
  },
}));

it('shows retry guidance in onboarding when a Codex runtime check fails', () => {
  const markup = renderToStaticMarkup(<OnboardingCliHealth onOpenTerminal={() => undefined} />);
  expect(markup).toContain('Please try again in a few moments');
  expect(markup).not.toContain('update Factory Factory');
});
