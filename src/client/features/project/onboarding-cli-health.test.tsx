import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { OnboardingCliHealth } from './onboarding-cli-health';

vi.mock('@/client/hooks/use-cli-health-refresh', () => ({
  useCLIHealthRefresh: () => ({ refresh: vi.fn(), isRefreshing: false }),
}));
const query = vi.hoisted(() => ({ failed: false }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      checkCLIHealth: {
        useQuery: () => ({
          error: query.failed ? { message: 'Backend unavailable' } : null,
          data: query.failed
            ? undefined
            : {
                claude: { isInstalled: true, isAuthenticated: true },
                codex: {
                  isInstalled: false,
                  isAuthenticated: false,
                  error:
                    'Please try again in a few moments. If this continues, try restarting Factory Factory.',
                },
                github: { isInstalled: true, isAuthenticated: true },
              },
          isRefetching: false,
        }),
      },
    },
  },
}));

it('shows a failed health check as an error with Retry', () => {
  query.failed = true;
  try {
    const markup = renderToStaticMarkup(<OnboardingCliHealth onOpenTerminal={() => undefined} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Couldn&#x27;t check CLI prerequisites');
    expect(markup).toContain('Backend unavailable');
    expect(markup).not.toContain('Checking CLI prerequisites');
  } finally {
    query.failed = false;
  }
});

it('shows retry guidance in onboarding when a Codex runtime check fails', () => {
  const markup = renderToStaticMarkup(<OnboardingCliHealth onOpenTerminal={() => undefined} />);
  expect(markup).toContain('Please try again in a few moments');
  expect(markup).not.toContain('update Factory Factory');
});
