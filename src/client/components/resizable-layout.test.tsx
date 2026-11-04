// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppLayout } from './resizable-layout';

const { navigation } = vi.hoisted(() => ({
  navigation: {
    projects: undefined as { slug: string }[] | undefined,
    projectsError: null as Error | null,
  },
}));
vi.mock('@/client/components/app-shortcuts', () => ({ AppShortcuts: () => null }));
vi.mock('@/client/hooks/use-app-navigation-data', () => ({
  useAppNavigationData: () => navigation,
  AppNavigationDataProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/hooks/use-sidebar-default-open', () => ({
  useRouteSidebarState: () => [true, vi.fn()],
}));
vi.mock('@/client/components/app-header-context', () => ({
  AppHeaderProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/app-sidebar', () => ({
  AppSidebar: () => <aside>Project navigation</aside>,
}));
vi.mock('@/client/components/app-header', () => ({
  AppHeader: ({ showSidebarToggle = true }: { showSidebarToggle?: boolean }) => (
    <header>{showSidebarToggle ? <button>Toggle sidebar</button> : null}</header>
  ),
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
it.each([
  [[], null, false],
  [undefined, null, true],
  [undefined, new Error('Offline'), true],
  [[], new Error('Refresh failed'), true],
  [[{ slug: 'alpha' }], null, true],
])('keeps navigation available for projects %j with error %s', async (projects, error, visible) => {
  navigation.projects = projects;
  navigation.projectsError = error;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() => root.render(<AppLayout>Project content</AppLayout>));
  expect(Boolean(container.querySelector('aside'))).toBe(visible);
  expect(Boolean(container.querySelector('header button'))).toBe(visible);
  expect(container.querySelector('main')?.textContent).toBe('Project content');
  await act(() => root.unmount());
});
