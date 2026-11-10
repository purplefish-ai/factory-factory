// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import type { ProjectIssuesStatus } from '@/client/hooks/use-project-issues';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { SidebarProvider } from '@/components/ui/sidebar';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import { AppSidebar } from './app-sidebar';

const rowRenders = vi.hoisted(() => vi.fn());
vi.mock('@/client/features/kanban/inline-workspace-form', () => ({
  InlineWorkspaceForm: ({ onLaunching }: { onLaunching: (id: string) => void }) => (
    <button type="button" onClick={() => onLaunching('optimistic-launch')}>
      Launch
    </button>
  ),
}));

function CurrentLocation() {
  return <output>{useLocation().pathname}</output>;
}
const issueState = vi.hoisted(() => ({
  issues: [] as NormalizedIssue[] | undefined,
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

it('encodes project slugs when selecting a launch immediately', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter>
          <SidebarProvider>
            <AppSidebar navData={{ ...navData, selectedProjectSlug: 'team/repo' }} />
            <CurrentLocation />
          </SidebarProvider>
        </MemoryRouter>
      )
    );
    const newWorkspace = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'New workspace'
    );
    await act(async () => newWorkspace?.click());
    const launch = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Launch'
    );
    expect(launch).toBeDefined();
    await act(async () => launch?.click());
    expect(container.querySelector('output')?.textContent).toBe(
      '/projects/team%2Frepo/workspaces/optimistic-launch'
    );
  } finally {
    await act(() => root.unmount());
  }
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

it('keeps workspace groups above Todo when assigned issues are present', async () => {
  issueState.issues = [
    {
      id: '42',
      displayId: '#42',
      title: 'Fix login redirect',
      body: '',
      url: 'https://github.com/acme/repo/issues/42',
      createdAt: '2026-11-01T12:00:00Z',
      author: 'octocat',
      provider: 'github',
      githubIssueNumber: 42,
    },
  ];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter>
          <SidebarProvider>
            <AppSidebar navData={navData} />
          </SidebarProvider>
        </MemoryRouter>
      )
    );
    expect(
      [...container.querySelectorAll('[data-sidebar="group-label"]')].map(
        (label) => label.textContent
      )
    ).toEqual(['Working', 'Waiting', 'Done', 'Todo']);
  } finally {
    await act(() => root.unmount());
  }
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

async function renderSidebar(data: AppNavigationData) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter>
        <SidebarProvider>
          <AppSidebar navData={data} />
        </SidebarProvider>
      </MemoryRouter>
    )
  );
  return { container, unmount: () => act(() => root.unmount()) };
}

it('shows a failed workspace list as an error with Retry, not as empty groups', async () => {
  const retry = vi.fn();
  const { container, unmount } = await renderSidebar({
    ...navData,
    serverWorkspaces: undefined,
    serverWorkspacesError: { message: 'Failed to fetch', isRetrying: false, retry },
  });
  try {
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load workspaces");
    expect(container.textContent).not.toContain('No active workspaces');
    act(() => alert?.querySelector('button')?.click());
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    await unmount();
  }
});

it('shows an unresolved workspace list as loading, not as empty groups', async () => {
  const { container, unmount } = await renderSidebar({ ...navData, serverWorkspaces: undefined });
  try {
    expect(container.textContent).toContain('Loading workspaces…');
    expect(container.textContent).not.toContain('No active workspaces');
  } finally {
    await unmount();
  }
});

it('keeps cached workspace rows when a refresh fails', async () => {
  const { container, unmount } = await renderSidebar({
    ...navData,
    serverWorkspacesError: { message: 'Failed to fetch', isRetrying: false, retry: vi.fn() },
  });
  try {
    expect(rowRenders).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Couldn't refresh workspaces");
  } finally {
    await unmount();
  }
});

it('follows the pointer while resizing and stores the width once the drag ends', async () => {
  localStorage.setItem('sidebar_width', '400');
  // jsdom has no pointer capture.
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    hasPointerCapture: () => true,
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter>
          <SidebarProvider>
            <AppSidebar navData={navData} />
          </SidebarProvider>
        </MemoryRouter>
      )
    );
    const handle = container.querySelector<HTMLElement>('[aria-label="Resize sidebar"]');
    const sidebar = handle?.parentElement;
    expect(sidebar?.style.width).toBe('400px');
    await act(() => {
      handle?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 400 }));
    });
    for (const clientX of [420, 460, 480]) {
      await act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
      });
    }
    expect(sidebar?.style.width).toBe('480px');
    expect(setItem.mock.calls.filter(([key]) => key === 'sidebar_width')).toEqual([]);
    await act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', {}));
    });
    expect(sidebar?.style.width).toBe('480px');
    expect(setItem.mock.calls.filter(([key]) => key === 'sidebar_width')).toEqual([
      ['sidebar_width', '480'],
    ]);
  } finally {
    await act(() => root.unmount());
    vi.restoreAllMocks();
    localStorage.clear();
  }
});
