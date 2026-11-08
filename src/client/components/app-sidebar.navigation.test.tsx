// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';

vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => ({ issues: [] }) }));
const viewport = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => viewport.isMobile,
}));
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
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: vi.fn(),
  currentWorkspaceId: undefined,
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  viewport.isMobile = false;
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
  ['/projects/alpha/workspaces', 'board'],
  ['/projects/alpha/workspaces/', 'board'],
  // Workspace detail lives under the board URL, but the workspace row owns the
  // active state there, so Board must not also read as the current page.
  ['/projects/alpha/workspaces/workspace', null],
])(
  'keeps project-scoped Board, Automations and Reviews above global Settings for %s',
  async (path, active) => {
    const view = await render(path);
    try {
      const board = view.container.querySelector('a[href="/projects/alpha/workspaces"]');
      const agents = view.container.querySelector('a[href="/projects/alpha/agents"]');
      const reviews = view.container.querySelector('a[href="/projects/alpha/reviews"]');
      expect(board?.getAttribute('data-active')).toBe(active === 'board' ? 'true' : 'false');
      expect(agents?.getAttribute('data-active')).toBe(active === 'agents' ? 'true' : 'false');
      expect(reviews?.getAttribute('data-active')).toBe(active === 'reviews' ? 'true' : 'false');
      expect(
        [...view.container.querySelectorAll('[data-sidebar="footer"] a[aria-current="page"]')].map(
          (link) => link.getAttribute('href')
        )
      ).toEqual(
        active === 'board'
          ? ['/projects/alpha/workspaces']
          : active
            ? [`/projects/alpha/${active}`]
            : []
      );
      expect(reviews?.textContent).toBe('Reviews3');
      expect(
        [...view.container.querySelectorAll('[data-sidebar="footer"] a')].map(
          (link) => link.textContent
        )
      ).toEqual(['Board', 'Automations', 'Reviews3', 'Settings']);
      expect(view.container.querySelector('a[href="/projects/stale/agents"]')).toBeNull();
    } finally {
      await view.dispose();
    }
  }
);
it('shows working and waiting board counts by column, excluding completed workspaces', async () => {
  const serverWorkspaces = (['WORKING', 'WAITING', 'WAITING', 'DONE'] as const).map(
    (kanbanColumn, index) => ({
      ...createOptimisticWorkspaceSummary({
        id: `workspace-${index}`,
        projectId: 'stale-id',
        name: `Workspace ${index}`,
        ratchetEnabled: true,
      }),
      kanbanColumn,
      isWorking: kanbanColumn !== 'WORKING',
    })
  );
  const view = await render('/admin', { ...navData, serverWorkspaces });
  try {
    const board = view.container.querySelector('a[href="/projects/stale/workspaces"]');
    expect([...board!.querySelectorAll('[data-variant]')].map((chip) => chip.textContent)).toEqual([
      '1',
      '2',
    ]);
    expect(document.getElementById(board!.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Working 1 Waiting 2'
    );
  } finally {
    await view.dispose();
  }
});
it.each([
  ['/admin', { ...navData, serverWorkspaces: undefined }],
  ['/projects/other/settings', navData],
])('hides unknown or differently scoped board counts on %s', async (path, data) => {
  const view = await render(path, data);
  try {
    const board = view.container.querySelector('a[aria-label="Board"]');
    expect(board?.textContent).toBe('Board');
    expect(board?.hasAttribute('aria-describedby')).toBe(false);
  } finally {
    await view.dispose();
  }
});
it('shows zero board counts when the project has no workspaces', async () => {
  const view = await render('/admin');
  try {
    const board = view.container.querySelector('a[href="/projects/stale/workspaces"]');
    expect([...board!.querySelectorAll('[data-variant]')].map((chip) => chip.textContent)).toEqual([
      '0',
      '0',
    ]);
  } finally {
    await view.dispose();
  }
});
it('uses the selected project outside project routes', async () => {
  const view = await render('/admin');
  try {
    expect(view.container.querySelector('a[href="/projects/stale/agents"]')).not.toBeNull();
    expect(view.container.querySelector('a[href="/projects/stale/workspaces"]')).not.toBeNull();
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
    expect(view.container.querySelector('a[href$="/workspaces"]')).toBeNull();
    const disabled = [
      ...view.container.querySelectorAll<HTMLButtonElement>('button[disabled]'),
    ].map((button) => button.textContent);
    expect(disabled).toContain('Board');
    expect(disabled).toContain('Automations');
    expect(disabled).toContain('Reviews');
  } finally {
    await view.dispose();
  }
});
function OpenMobileSidebar() {
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(true), [setOpenMobile]);
  return null;
}
function CurrentPath() {
  return <output>{useLocation().pathname}</output>;
}
it('offers Board in the mobile sheet and closes the sheet after navigating to it', async () => {
  viewport.isMobile = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={['/projects/alpha/workspaces/workspace']}>
        <SidebarProvider>
          <OpenMobileSidebar />
          <CurrentPath />
          <AppSidebar navData={{ ...navData, selectedProjectSlug: 'alpha' }} />
        </SidebarProvider>
      </MemoryRouter>
    )
  );
  try {
    const board = document.body.querySelector<HTMLAnchorElement>(
      '[role="dialog"] a[href="/projects/alpha/workspaces"]'
    );
    expect(board?.getAttribute('aria-label')).toBe('Board');
    expect([...board!.querySelectorAll('[data-variant]')].map((chip) => chip.textContent)).toEqual([
      '0',
      '0',
    ]);
    expect(board?.getAttribute('aria-current')).toBeNull();
    await act(() => board!.click());
    expect(container.querySelector('output')?.textContent).toBe('/projects/alpha/workspaces');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
