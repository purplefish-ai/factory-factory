// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { IssuesColumn } from '@/client/features/kanban/issues-column';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import type { ProjectIssuesStatus } from '@/client/hooks/use-project-issues';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';

const state = vi.hoisted(() => ({
  status: 'ready' as ProjectIssuesStatus,
  error: null as string | null,
  isFetching: false,
  refetch: vi.fn(),
}));
const issues: NormalizedIssue[] = [
  {
    id: '7',
    title: 'Retained issue',
    displayId: '#7',
    provider: 'github',
    body: '',
    url: 'https://github.com/acme/repo/issues/7',
    author: 'octocat',
    createdAt: '2026-11-04T12:00:00Z',
    githubIssueNumber: 7,
  },
];
vi.mock('@/client/hooks/use-project-issues', () => ({
  useProjectIssues: () => ({ issues, ...state }),
}));
vi.mock('@/client/features/kanban/kanban-context', () => ({
  useKanban: () => ({
    workspaces: [],
    showInlineForm: false,
    setShowInlineForm: vi.fn(),
    projectSlug: 'alpha',
    issuesStatus: state.status,
    issuesError: state.error,
    isFetchingIssues: state.isFetching,
    refetchIssues: state.refetch,
  }),
}));
vi.mock('@/client/features/kanban/issue-card', () => ({
  IssueCard: ({ issue }: { issue: NormalizedIssue }) => <span>{issue.title}</span>,
}));
vi.mock('@/client/features/kanban/inline-workspace-form', () => ({
  InlineWorkspaceForm: () => null,
}));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));

const navData: AppNavigationData = {
  projects: [],
  projectsError: null,
  refetchProjects: vi.fn(),
  selectedProjectSlug: 'alpha',
  selectProjectSlug: vi.fn(),
  selectedProjectId: 'alpha',
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 0,
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: vi.fn(),
  currentWorkspaceId: undefined,
};
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it.each(['board', 'sidebar'] as const)(
  'keeps cached Todo issues visible through failed refresh and pending retry on %s',
  async (surface) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    state.status = 'ready';
    state.error = null;
    state.isFetching = false;
    state.refetch.mockReset();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () =>
      act(() =>
        root.render(
          <MemoryRouter>
            <SidebarProvider>
              {surface === 'board' ? (
                <IssuesColumn
                  column={{ id: 'ISSUES', label: 'Todo', description: 'Assigned issues' }}
                  issues={issues}
                  projectId="alpha"
                />
              ) : (
                // AppSidebar is memoized and the mocked issues hook is not a
                // subscription, so a new object stands in for a query update.
                <AppSidebar navData={{ ...navData }} />
              )}
            </SidebarProvider>
          </MemoryRouter>
        )
      );
    await render();
    expect(container.textContent).toContain('Retained issue');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    state.status = 'error';
    state.error = 'Network offline';
    await render();
    expect(container.textContent).toContain('Retained issue');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Network offline');
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    expect(retry).toBeDefined();
    await act(() => retry!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    state.isFetching = true;
    await render();
    const pending = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retrying…'
    );
    expect(pending?.disabled).toBe(true);
    expect(container.textContent).toContain('Retained issue');
    expect(container.textContent).not.toContain('No assigned issues');
    expect(container.querySelector('[aria-label="Loading issues"]')).toBeNull();
    state.status = 'ready';
    state.error = null;
    state.isFetching = false;
    await render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Retained issue');
    await act(() => root.unmount());
  }
);
