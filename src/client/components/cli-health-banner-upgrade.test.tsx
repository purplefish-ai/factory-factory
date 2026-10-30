// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { CLIHealthBanner } from './cli-health-banner';

it.each([false, true])(
  'removes the update button after upgrading (older health request in flight: %s)',
  async (withStaleRequest) => {
    localStorage.clear();
    const oldHealth = {
      claude: {
        isInstalled: true,
        version: '2.1.310',
        latestVersion: '2.1.312',
        isOutdated: true,
      },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: false },
      allHealthy: false,
    };
    const newHealth = {
      ...oldHealth,
      claude: { ...oldHealth.claude, version: '2.1.312', isOutdated: false },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let healthRequests = 0;
    let finishUpgrade = () => undefined;
    let finishOldHealth = () => undefined;
    const client = trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'admin.upgradeProviderCLI') {
                finishUpgrade = () => {
                  observer.next({
                    result: {
                      data: { health: newHealth, message: 'Claude CLI upgraded successfully.' },
                    },
                  });
                  observer.complete();
                };
              } else if (++healthRequests === 1) {
                observer.next({ result: { data: oldHealth } });
                observer.complete();
              } else {
                finishOldHealth = () => {
                  observer.next({ result: { data: oldHealth } });
                  observer.complete();
                };
              }
            }),
      ],
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    const queryKey = getQueryKey(trpc.admin.checkCLIHealth, { forceRefresh: false }, 'query');
    try {
      flushSync(() =>
        root.render(
          <trpc.Provider client={client} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
              <CLIHealthBanner />
            </QueryClientProvider>
          </trpc.Provider>
        )
      );
      await vi.waitFor(() => {
        expect(container.querySelector('button[aria-label="Update Claude"]')).not.toBeNull();
      });
      flushSync(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Update Claude"]')?.click()
      );
      await vi.waitFor(() => expect(container.textContent).toContain('Updating Claude'));
      if (withStaleRequest) {
        void queryClient.refetchQueries({ queryKey });
        await vi.waitFor(() => expect(healthRequests).toBe(2));
      }
      finishUpgrade();
      await vi.waitFor(() => {
        expect(container.querySelector('[aria-label="Update Claude"]')).toBeNull();
        expect(container.querySelector('[aria-label="Updating Claude"]')).toBeNull();
        expect(queryClient.getQueryData(queryKey)).toEqual(newHealth);
      });
      finishOldHealth();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(queryClient.getQueryData(queryKey)).toEqual(newHealth);
      expect(container.textContent).toContain('GitHub sign-in required');
      expect(healthRequests).toBe(withStaleRequest ? 2 : 1);
    } finally {
      flushSync(() => root.unmount());
      queryClient.clear();
    }
  }
);
