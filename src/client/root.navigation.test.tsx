// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';
import { Root } from './root';

vi.mock('@/client/lib/providers', () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => children,
  useProjects: () => ({ projects: [], isLoading: false }),
}));
vi.mock('@/client/components/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/appearance-provider', () => ({
  AppearanceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/resizable-layout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/cli-health-banner', () => ({ CLIHealthBanner: () => null }));
vi.mock('@/client/components/model-catalog-warning', () => ({ ModelCatalogWarning: () => null }));
vi.mock('@/client/features/workspace/WorkspaceNotificationManager', () => ({
  WorkspaceNotificationManager: () => null,
}));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => ({ height: '100vh', offsetTop: '0px' }),
}));
function Location() {
  const { pathname, search } = useLocation();
  return (
    <output>
      {pathname}
      {search}
    </output>
  );
}
it.each([
  ['/agents/archived-agent', '/agents/archived-agent'],
  ['/AGENTS/archived-agent/', '/AGENTS/archived-agent/'],
  ['/reviews?repo=archived/repository&pr=12', '/reviews?repo=archived/repository&pr=12'],
  ['/Reviews/?repo=archived/repository&pr=12', '/Reviews/?repo=archived/repository&pr=12'],
  ['/projects/archived/agents/agent', '/projects/archived/agents/agent'],
  ['/agents', '/projects/new'],
  ['/reviews', '/projects/new'],
])(
  'allows explicit owner resolution before onboarding with no active projects: %s',
  async (path, expected) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={<Root />}>
                <Route path="*" element={<Location />} />
              </Route>
            </Routes>
          </MemoryRouter>
        )
      );
      expect(container.querySelector('output')?.textContent).toBe(expected);
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  }
);
