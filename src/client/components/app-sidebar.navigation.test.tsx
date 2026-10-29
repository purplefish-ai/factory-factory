// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';

vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => ({ issues: [] }) }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));
const navData: AppNavigationData = {
  projects: [],
  projectsError: null,
  refetchProjects: vi.fn(),
  selectedProjectSlug: 'alpha',
  selectProjectSlug: vi.fn(),
  selectedProjectId: undefined,
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 0,
  needsAttention: () => false,
  clearAttention: vi.fn(),
  currentWorkspaceId: undefined,
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
it.each(['/projects/alpha/agents', '/projects/alpha/reviews', '/admin'])(
  'keeps Settings global and project sections in the navbar for %s',
  async (path) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <MemoryRouter initialEntries={[path]}>
            <SidebarProvider>
              <AppSidebar navData={navData} />
            </SidebarProvider>
          </MemoryRouter>
        )
      );
      expect(
        [...container.querySelectorAll('a')].some(
          (link) => link.textContent === 'Agents' || link.textContent === 'Reviews'
        )
      ).toBe(false);
      expect(container.querySelector('a[href="/admin"]')?.getAttribute('data-active')).toBe(
        path === '/admin' ? 'true' : 'false'
      );
    } finally {
      await act(() => root.unmount());
    }
  }
);
