// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import type { ProjectIssuesStatus } from '@/client/hooks/use-project-issues';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { SidebarProvider } from '@/components/ui/sidebar';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import { AppSidebar } from './app-sidebar';

const rowRenders = vi.hoisted(() => vi.fn());
const issueState = vi.hoisted(() => ({
  issues: [] as undefined | [],
  status: 'ready' as ProjectIssuesStatus,
}));
vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => issueState }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('./workspace-item-content', () => ({
  WorkspaceItemContent: ({ workspace }: { workspace: { id: string; name: string } }) => {
    rowRenders(workspace.id);
    return <span>{workspace.name}</span>;
  },
}));

const workspaces = ['ws-1', 'ws-2', 'ws-3'].map((workspaceId) =>
  projectSnapshotToWorkspace(makeWorkspaceSnapshotEntry({ workspaceId, name: workspaceId }))
);
const navData: AppNavigationData = {
  projects: [],
  projectsError: null,
  refetchProjects: vi.fn(),
  selectedProjectSlug: 'alpha',
  selectProjectSlug: vi.fn(),
  selectedProjectId: 'alpha-id',
  issueProvider: 'GITHUB',
  serverWorkspaces: workspaces,
  reviewCount: 0,
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: vi.fn(),
  currentWorkspaceId: undefined,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  issueState.issues = [];
  issueState.status = 'ready';
  rowRenders.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('re-renders only the workspace row whose snapshot changed', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (data: AppNavigationData) =>
    act(() =>
      root.render(
        <MemoryRouter initialEntries={['/projects/alpha/workspaces']}>
          <SidebarProvider>
            <AppSidebar navData={data} />
          </SidebarProvider>
        </MemoryRouter>
      )
    );

  await render(navData);
  expect(rowRenders).toHaveBeenCalledTimes(3);
  expect(
    [...container.querySelectorAll('[data-sidebar="group-label"]')].map(
      (label) => label.textContent
    )
  ).toEqual(['Working', 'Waiting', 'Done']);
  rowRenders.mockClear();

  // A workspace snapshot replaces one row object and keeps the others.
  const changed = { ...workspaces[1]!, name: 'renamed' };
  await render({ ...navData, serverWorkspaces: [workspaces[0]!, changed, workspaces[2]!] });

  expect(rowRenders.mock.calls).toEqual([['ws-2']]);
  expect(container.textContent).toContain('renamed');
  await act(() => root.unmount());
});

it.each<ProjectIssuesStatus>(['ready', 'loading', 'not-connected', 'error', 'no-project'])(
  'hides the Todo section without assigned issues when %s',
  async (status) => {
    issueState.status = status;
    issueState.issues = status === 'loading' || status === 'no-project' ? undefined : [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() =>
      root.render(
        <MemoryRouter>
          <SidebarProvider>
            <AppSidebar navData={navData} />
          </SidebarProvider>
        </MemoryRouter>
      )
    );
    expect(container.textContent).not.toContain('Todo');
    expect(container.textContent).not.toContain('No assigned issues');
    expect(container.textContent).toContain('Working');
    await act(() => root.unmount());
  }
);
