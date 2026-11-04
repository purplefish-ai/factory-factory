// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { ChildWorkspaceSettingsSection } from './ChildWorkspaceSettingsSection';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

it.each([true, false])(
  'renders enabled=%s and retains the saved preference while refresh is pending',
  async (enabled) => {
    let settings = { childWorkspacesEnabled: enabled };
    const writes: unknown[] = [];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'userSettings.update') {
                writes.push(op.input);
                settings = { childWorkspacesEnabled: !enabled };
              } else if (op.path === 'userSettings.get' && writes.length > 0) {
                return;
              } else if (op.path !== 'userSettings.get') {
                observer.error(new TRPCClientError(`Unexpected request: ${op.path}`));
                return;
              }
              observer.next({ result: { data: settings } });
              observer.complete();
            }),
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(
          <trpc.Provider client={client} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
              <ChildWorkspaceSettingsSection />
            </QueryClientProvider>
          </trpc.Provider>
        );
      });
      const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]');
      await act(async () => {
        await vi.waitFor(() =>
          expect(toggle()?.getAttribute('aria-checked')).toBe(String(enabled))
        );
      });
      await act(() => {
        toggle()?.click();
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(toggle()?.getAttribute('aria-checked')).toBe(String(!enabled))
        );
      });
      expect(writes).toEqual([{ childWorkspacesEnabled: !enabled }]);
    } finally {
      await act(() => root.unmount());
      queryClient.clear();
    }
  }
);

it('shows a read error without offering an unknown toggle state', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      () => () =>
        observable((observer) => {
          observer.error(new TRPCClientError('Settings unavailable'));
        }),
    ],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <ChildWorkspaceSettingsSection />
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load")
      );
    });
    expect(container.querySelector('[role="switch"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
  }
});
