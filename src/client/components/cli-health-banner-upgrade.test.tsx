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
  'keeps global update controls absent when a health refetch is stale: %s',
  async (staleRefetch) => {
    localStorage.clear();
    const oldHealth = {
      claude: {
        isInstalled: true,
        isAuthenticated: true,
        version: '2.1.310',
        latestVersion: '2.1.312',
        isOutdated: true,
      },
      codex: { isInstalled: true, isAuthenticated: true },
      github: { isInstalled: true, isAuthenticated: false },
      allHealthy: false,
    };
    const currentHealth = {
      ...oldHealth,
      claude: { ...oldHealth.claude, version: '2.1.312', isOutdated: false },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const operations: string[] = [];
    const client = trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              operations.push(op.path);
              observer.next({
                result: {
                  data: operations.length === 1 || staleRefetch ? oldHealth : currentHealth,
                },
              });
              observer.complete();
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
      await vi.waitFor(() => expect(container.textContent).toContain('GitHub sign-in required'));
      expect(container.textContent).not.toContain('Update Claude');
      const recheck = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Recheck')
      );
      expect(recheck).toBeDefined();
      flushSync(() => recheck?.click());
      await vi.waitFor(() => expect(operations).toHaveLength(2));
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(queryKey)).toEqual(staleRefetch ? oldHealth : currentHealth)
      );
      expect(container.querySelector('[aria-label="Update Claude"]')).toBeNull();
      expect(container.querySelector('[aria-label="Updating Claude"]')).toBeNull();
      expect(container.textContent).toContain('GitHub sign-in required');
      expect(operations).toEqual(['admin.checkCLIHealth', 'admin.checkCLIHealth']);
    } finally {
      flushSync(() => root.unmount());
      queryClient.clear();
    }
  }
);
