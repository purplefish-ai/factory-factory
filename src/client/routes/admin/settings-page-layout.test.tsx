// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPageLayout } from './settings-page-layout';

const mocks = vi.hoisted(() => ({
  isMobile: false,
  selectedProjectSlug: 'alpha',
  projectsError: null as Error | null,
  refetchProjects: vi.fn(),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  useAppHeader: vi.fn(),
}));
vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
  useAppNavigationDataContext: () => ({
    projects: [{ id: 'a', slug: 'alpha', name: 'Alpha' }],
    selectedProjectSlug: mocks.selectedProjectSlug,
    selectProjectSlug: vi.fn(),
    projectsError: mocks.projectsError,
    refetchProjects: mocks.refetchProjects,
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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.isMobile = false;
  mocks.selectedProjectSlug = 'alpha';
  mocks.projectsError = null;
  mocks.refetchProjects.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
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
        'header [aria-label="Open project menu"]'
      );
      expect(projectButton).not.toBeNull();
      await act(() => projectButton?.click());
      expect(container.querySelector('output')?.textContent).toBe(path);
    } finally {
      await act(() => root.unmount());
    }
  }
);

it('keeps the project menu enabled when there is no selection', async () => {
  mocks.selectedProjectSlug = '';
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={['/admin']}>
          <Page />
        </MemoryRouter>
      )
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[title="Select a project"]')?.disabled
    ).toBe(false);
    expect(container.querySelector('[aria-label="Open project menu"]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
it('keeps the project action and Settings breadcrumb on mobile', async () => {
  mocks.isMobile = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={['/admin']}>
          <Page />
        </MemoryRouter>
      )
    );
    const project = container.querySelector<HTMLButtonElement>('[aria-label="Open project menu"]');
    expect(project?.textContent).toBe('Alpha');
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Settings');
    await act(() => project?.click());
    expect(container.querySelector('output')?.textContent).toBe('/admin');
  } finally {
    await act(() => root.unmount());
  }
});
it('announces project-list failures and retries from the header menu', async () => {
  mocks.projectsError = new Error('Projects unavailable');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={['/admin']}>
          <Page />
        </MemoryRouter>
      )
    );
    expect(container.querySelector('header [role="alert"]')?.textContent).toContain(
      'Projects unavailable'
    );
    await act(() =>
      container
        .querySelector('[aria-label="Open project menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    const retry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Retry projects'
    );
    expect(retry).toBeDefined();
    await act(() => retry?.click());
    expect(mocks.refetchProjects).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
