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
  selectedProjectSlug: 'stale',
  selectProjectSlug: vi.fn(),
  selectedProjectId: 'stale-id',
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 3,
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
async function render(path: string, data = navData) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <AppSidebar navData={data} />
        </SidebarProvider>
      </MemoryRouter>
    )
  );
  return { container, dispose: () => act(() => root.unmount()) };
}
it.each([
  ['/projects/alpha/agents', 'agents'],
  ['/projects/alpha/agents/review', 'agents'],
  ['/projects/alpha/reviews', 'reviews'],
  ['/projects/alpha/workspaces/workspace', null],
])('keeps project-scoped Agents and Reviews above global Settings for %s', async (path, active) => {
  const view = await render(path);
  try {
    const agents = view.container.querySelector('a[href="/projects/alpha/agents"]');
    const reviews = view.container.querySelector('a[href="/projects/alpha/reviews"]');
    expect(agents?.getAttribute('data-active')).toBe(active === 'agents' ? 'true' : 'false');
    expect(reviews?.getAttribute('data-active')).toBe(active === 'reviews' ? 'true' : 'false');
    expect(reviews?.textContent).toBe('Reviews3');
    expect(
      [...view.container.querySelectorAll('[data-sidebar="footer"] a')].map(
        (link) => link.textContent
      )
    ).toEqual(['Agents', 'Reviews3', 'Settings']);
    expect(view.container.querySelector('a[href="/projects/stale/agents"]')).toBeNull();
  } finally {
    await view.dispose();
  }
});
it('uses the selected project outside project routes', async () => {
  const view = await render('/admin');
  try {
    expect(view.container.querySelector('a[href="/projects/stale/agents"]')).not.toBeNull();
    expect(view.container.querySelector('a[href="/admin"]')?.getAttribute('data-active')).toBe(
      'true'
    );
  } finally {
    await view.dispose();
  }
});
it('keeps an archived URL owner authoritative without active projects', async () => {
  const view = await render('/projects/archived/agents', {
    ...navData,
    selectedProjectId: undefined,
    selectedProjectSlug: '',
  });
  try {
    expect(
      view.container
        .querySelector('a[href="/projects/archived/agents"]')
        ?.getAttribute('data-active')
    ).toBe('true');
  } finally {
    await view.dispose();
  }
});
it('disables project section navigation when no project is available', async () => {
  const view = await render('/admin', {
    ...navData,
    selectedProjectId: undefined,
    selectedProjectSlug: '',
  });
  try {
    expect(view.container.querySelector('a[href="/agents"]')).toBeNull();
    expect(view.container.querySelector('a[href="/reviews"]')).toBeNull();
    const disabled = [
      ...view.container.querySelectorAll<HTMLButtonElement>('button[disabled]'),
    ].map((button) => button.textContent);
    expect(disabled).toContain('Agents');
    expect(disabled).toContain('Reviews');
  } finally {
    await view.dispose();
  }
});
