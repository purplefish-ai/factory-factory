// @vitest-environment jsdom

import { QueryClient, QueryObserver, type RefetchOptions } from '@tanstack/react-query';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { CLIHealthBanner } from './cli-health-banner';

const mocks = vi.hoisted(() => ({
  refetch: vi.fn<(options?: RefetchOptions) => Promise<unknown>>(),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ admin: { checkCLIHealth: { setData: vi.fn() } } }),
    admin: {
      upgradeProviderCLI: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      checkCLIHealth: {
        useQuery: () => ({
          data: {
            claude: { isInstalled: true },
            codex: { isInstalled: true, isAuthenticated: true },
            github: { isInstalled: false, isAuthenticated: false },
          },
          isLoading: false,
          isRefetching: false,
          refetch: mocks.refetch,
        }),
      },
    },
  },
}));

describe('CLI health recheck', () => {
  it('reports failed rechecks using the real query refetch contract', async () => {
    localStorage.clear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      queryKey: ['health-recheck'],
      enabled: false,
      queryFn: () => Promise.reject(new Error('Provider status unavailable')),
    });
    mocks.refetch.mockImplementation(observer.refetch);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(createElement(CLIHealthBanner)));
      const button = [...container.querySelectorAll('button')].find((element) =>
        element.textContent?.includes('Recheck')
      );
      expect(button).toBeDefined();
      flushSync(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await vi.waitFor(() => {
        expect(toast.getHistory()).toContainEqual(
          expect.objectContaining({
            title: 'Could not check provider status',
            description: 'Provider status unavailable',
          })
        );
      });
    } finally {
      flushSync(() => root.unmount());
      client.clear();
    }
  });
});
