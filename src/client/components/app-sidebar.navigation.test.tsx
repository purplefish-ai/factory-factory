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
it.each(['/agents', '/agents/review'])(
  'marks Agents active for %s and exposes its navigation link',
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
      const link = container.querySelector('a[href="/agents"]');
      expect(link?.textContent).toBe('Agents');
      expect(link?.getAttribute('data-active')).toBe('true');
      expect(container.querySelector('a[href="/admin"]')?.getAttribute('data-active')).toBe(
        'false'
      );
    } finally {
      await act(() => root.unmount());
    }
  }
);
