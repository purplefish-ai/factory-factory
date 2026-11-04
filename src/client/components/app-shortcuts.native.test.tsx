// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { within } from 'storybook/test';
import { expect, it, vi } from 'vitest';
import { GlobalSearch } from '@/client/features/search';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import type { DesktopCommand } from '@/types/electron';
import { AppShortcuts } from './app-shortcuts';

function AppState() {
  const location = useLocation();
  const { open } = useSidebar();
  return (
    <output data-testid="app-state">
      {location.pathname}
      {location.search} · {open ? 'expanded' : 'collapsed'}
    </output>
  );
}

it('routes native menu commands through mounted app handlers, including search focus and first-run project selection', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        /* jsdom has no layout observation. */
      }
      unobserve() {
        /* No observer resources. */
      }
      disconnect() {
        /* No observer resources. */
      }
    }
  );
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  localStorage.clear();
  let receive: ((command: DesktopCommand) => void) | undefined;
  const unsubscribe = vi.fn();
  vi.stubGlobal('electronAPI', {
    onAppCommand: (listener: (command: DesktopCommand) => void) => {
      receive = listener;
      return unsubscribe;
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = trpc.createClient({
    links: [
      () => () =>
        observable((observer) => {
          observer.next({ result: { data: [] } });
          observer.complete();
        }),
    ],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const navData: ComponentProps<typeof AppShortcuts>['navData'] = {
    selectedProjectId: 'alpha-id',
    selectedProjectSlug: 'alpha',
    serverWorkspaces: [],
    currentWorkspaceId: undefined,
    needsAttention: () => false,
  };
  const render = (data: typeof navData) =>
    act(() =>
      root.render(
        <trpc.Provider client={api} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={['/projects/alpha/workspaces']}>
              <SidebarProvider defaultOpen>
                <AppShortcuts navData={data} />
                <GlobalSearch />
                <AppState />
              </SidebarProvider>
            </MemoryRouter>
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
  try {
    await render(navData);
    expect(receive).toBeTypeOf('function');
    await act(() => receive?.('nav.settings'));
    expect(container.querySelector('output')?.textContent).toBe('/admin · expanded');
    await act(() => receive?.('nav.newWorkspace'));
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/alpha/workspaces?new=1 · expanded'
    );
    await act(() => receive?.('app.toggleSidebar'));
    expect(container.querySelector('output')?.textContent).toContain('collapsed');
    await act(() => receive?.('app.search'));
    expect(within(document.body).getByRole('dialog', { name: 'Search' })).toBeDefined();
    expect(within(document.body).getByRole('combobox')).toBe(document.activeElement);
    await act(() => receive?.('app.search'));
    await act(async () => {
      await vi.waitFor(() =>
        expect(within(document.body).queryByRole('dialog', { name: 'Search' })).toBeNull()
      );
    });
    await render({ ...navData, selectedProjectId: undefined, selectedProjectSlug: '' });
    await act(() => receive?.('nav.newWorkspace'));
    expect(container.querySelector('output')?.textContent).toBe('/projects · collapsed');
    await act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
    container.remove();
    if (scroll) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    vi.unstubAllGlobals();
  }
});
