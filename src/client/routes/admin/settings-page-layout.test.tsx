// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPageLayout } from './settings-page-layout';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  useAppHeader: vi.fn(),
}));
vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
  useAppNavigationDataContext: () => ({
    projects: [{ id: 'a', slug: 'alpha', name: 'Alpha' }],
    selectedProjectSlug: 'alpha',
    selectProjectSlug: vi.fn(),
    projectsError: null,
    refetchProjects: vi.fn(),
  }),
}));
function Page() {
  const { pathname } = useLocation();
  return (
    <SettingsPageLayout>
      <output>{pathname}</output>
    </SettingsPageLayout>
  );
}
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
it.each(['/admin', '/admin/appearance', '/admin/system', '/admin/logs'])(
  'keeps project navigation in the header at %s',
  async (path) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <MemoryRouter initialEntries={[path]}>
            <Page />
          </MemoryRouter>
        )
      );
      expect(container.querySelector('header nav [aria-current="page"]')?.textContent).toBe(
        'Settings'
      );
      expect(container.querySelector('header [aria-label="Open project menu"]')).not.toBeNull();
      const projectButton = container.querySelector<HTMLButtonElement>(
        'header [aria-label="Open Alpha workspaces"]'
      );
      expect(projectButton).not.toBeNull();
      await act(() => projectButton?.click());
      expect(container.querySelector('output')?.textContent).toBe('/projects/alpha/workspaces');
    } finally {
      await act(() => root.unmount());
    }
  }
);
