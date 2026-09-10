// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { CliAuthSection } from './CliAuthSection';

vi.mock('@/client/features/project/use-setup-terminal', () => ({
  useSetupTerminal: () => ({ connected: false, showTerminal: false, gaveUp: false }),
}));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('CLI authentication refresh', () => {
  it.each(['Recheck', 'terminal close'])('refreshes displayed status after %s', async (trigger) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5000 } },
    });
    let authenticated = false;
    const client = trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const fresh =
                typeof op.input === 'object' &&
                op.input !== null &&
                'forceRefresh' in op.input &&
                op.input.forceRefresh === true &&
                authenticated;
              observer.next({
                result: {
                  data: {
                    claude: { isInstalled: true, isAuthenticated: fresh },
                    codex: { isInstalled: true, isAuthenticated: fresh },
                    github: { isInstalled: true, isAuthenticated: fresh },
                    allHealthy: fresh,
                  },
                },
              });
              observer.complete();
            }),
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const click = async (label: string) => {
      const button = Array.from(document.querySelectorAll('button')).find((item) =>
        item.textContent?.includes(label)
      );
      expect(button).toBeDefined();
      await act(async () => {
        button?.click();
        // React Query schedules observer notifications for the next task.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    try {
      await act(async () =>
        root.render(
          <trpc.Provider client={client} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
              <CliAuthSection />
            </QueryClientProvider>
          </trpc.Provider>
        )
      );
      await vi.waitFor(() => expect(container.textContent).toContain('run claude login'));
      // Warm the forced-query cache before the login, within production staleTime.
      await click('Recheck');
      authenticated = true;
      if (trigger === 'terminal close') {
        await click('Open Terminal to Log In');
        await click('Close');
      } else {
        await click('Recheck');
      }
      await vi.waitFor(() => {
        expect(container.textContent).not.toContain('run claude login');
        expect(container.textContent?.match(/Ready/g)).toHaveLength(3);
      });
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });
});
