import { act, createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
// @vitest-environment jsdom
import AdminDashboardPage from '@/client/routes/admin-page';
import ProjectSettingsRedirect from '@/client/routes/projects/settings';

vi.mock('@/client/routes/admin/settings-page-layout', () => ({
  SettingsPageLayout: ({ children }: { children: import('react').ReactNode }) => children,
}));
vi.mock('@/client/routes/admin/ProjectSettingsSection', () => ({
  ProjectSettingsSection: ({ project }: { project: { slug: string } }) =>
    createElement('section', { 'data-project': project.slug }),
}));

const mocks = vi.hoisted(() => ({
  listForProject: vi.fn(() => ({ data: { workspaces: [], reviewCount: 0 } })),
  mutate: vi.fn(),
  getBySlug: vi.fn(),
  reviewQuery: vi.fn(),
  resetReviews: vi.fn(),
  projectListQuery: vi.fn(),
  refetchProjectList: vi.fn(async () => ({ data: [] })),
  refetchBoardCounts: vi.fn(async () => ({ data: [] })),
}));
const mutation = { mutate: mocks.mutate };
vi.mock('@/client/hooks/use-project-workspace-query', () => {
  return {
    useProjectWorkspaceQuery: (projectId: string | undefined) =>
      trpc.workspace.listForProject.useQuery(
        { projectId: projectId ?? '' },
        { enabled: Boolean(projectId), staleTime: Infinity, refetchOnWindowFocus: false }
      ),
  };
});

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ prReview: { listReviewRequests: { reset: mocks.resetReviews } } }),
    prReview: { listReviewRequests: { useQuery: mocks.reviewQuery } },
    periodicTask: {
      navigationSummary: {
        useQuery: () => ({ data: undefined, isSuccess: false, isFetching: false }),
      },
    },
    agent: {
      navigationSummary: {
        useQuery: () => ({ data: undefined, isSuccess: false, isFetching: false }),
      },
    },
    project: {
      getBySlug: { useQuery: mocks.getBySlug },
      list: {
        useQuery: (
          input: { includeBoardCounts?: boolean } = {},
          options?: { enabled?: boolean }
        ) => {
          mocks.projectListQuery(input, options);
          return {
            refetch: input.includeBoardCounts ? mocks.refetchBoardCounts : mocks.refetchProjectList,
            data: [
              {
                id: 'alpha-id',
                slug: 'alpha',
                name: 'Alpha',
                issueProvider: 'GITHUB',
                githubOwner: 'o',
                githubRepo: 'alpha',
              },
              {
                id: 'new-id',
                slug: 'new',
                name: 'New',
                issueProvider: 'GITHUB',
                githubOwner: 'o',
                githubRepo: 'new',
              },
            ],
          };
        },
      },
    },
    workspace: {
      unreadMailCounts: { useQuery: () => ({ data: undefined }) },
      listForProject: { useQuery: mocks.listForProject },
      syncAllPRStatuses: { useMutation: () => mutation },
    },
  },
}));
vi.mock('@/client/hooks/use-project-snapshot-sync', () => ({ useProjectSnapshotSync: vi.fn() }));
vi.mock('@/client/hooks/use-workspace-attention', () => ({
  useWorkspaceAttention: () => ({ needsAttention: () => false, clearAttention: vi.fn() }),
}));

import { getProjectSlugFromPath, useAppNavigationData } from './use-app-navigation-data';

function NavigationHarness({
  selected,
}: {
  selected: { selectedProjectSlug?: string; selectedProjectId?: string; reviewCount?: number };
}) {
  const navigation = useAppNavigationData();
  selected.selectedProjectSlug = navigation.selectedProjectSlug;
  selected.selectedProjectId = navigation.selectedProjectId;
  selected.reviewCount = navigation.reviewCount;
  return (
    <button
      onClick={() => {
        void navigation.refetchProjects({ includeBoardCounts: true });
      }}
    >
      Open projects
    </button>
  );
}

beforeEach(() => {
  mocks.reviewQuery.mockReset().mockReturnValue({
    data: {
      prs: [
        { repository: { nameWithOwner: 'O/NEW' }, reviewDecision: 'REVIEW_REQUIRED' },
        { repository: { nameWithOwner: 'o/new' }, reviewDecision: 'APPROVED' },
        { repository: { nameWithOwner: 'foreign/new' }, reviewDecision: 'REVIEW_REQUIRED' },
      ],
    },
  });
  mocks.getBySlug.mockReset().mockImplementation(({ slug }: { slug: string }) => ({
    data: {
      id: `${slug}-id`,
      slug,
      name: slug,
      githubOwner: 'o',
      githubRepo: slug,
    },
  }));
  mocks.listForProject.mockReturnValue({ data: { workspaces: [], reviewCount: 99 } });
});

describe('project route selection', () => {
  it.each([
    ['/PROJECTS/space%20here/agents', 'space here'],
    ['/Projects/a%2Fb/reviews', 'a/b'],
    ['/PROJECTS/NEW/', null],
  ])('decodes the React Router URL owner in %s', (path, slug) => {
    expect(getProjectSlugFromPath(path)).toBe(slug);
  });

  it.each(['/projects/new', '/projects/new/'])('keeps %s as the project creation route', (path) => {
    expect(getProjectSlugFromPath(path)).toBeNull();
  });

  it.each(['/projects/new/workspaces', '/projects/new/settings', '/projects/new/workspaces/w1'])(
    'recognizes the project slug in %s',
    (path) => {
      expect(getProjectSlugFromPath(path)).toBe('new');
    }
  );

  it.each([true, false])(
    'preserves global selection when opening project settings (direct=%s)',
    async (direct) => {
      localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
      window.history.replaceState(
        {},
        '',
        direct ? '/projects/new/settings' : '/projects/alpha/workspaces'
      );
      const container = document.createElement('div');
      const root = createRoot(container);
      const selected: { selectedProjectSlug?: string; selectedProjectId?: string } = {};
      try {
        flushSync(() =>
          root.render(
            createElement(
              MemoryRouter,
              {
                initialEntries: [direct ? '/projects/new/settings' : '/projects/alpha/workspaces'],
              },
              createElement(NavigationHarness, { selected }),
              createElement(Link, { to: '/projects/new/settings' }, 'Project settings')
            )
          )
        );
        if (!direct) {
          await act(async () => container.querySelector<HTMLAnchorElement>('a')?.click());
        }
        expect(selected.selectedProjectSlug).toBe('alpha');
        expect(selected.selectedProjectId).toBe('alpha-id');
        expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('alpha');
      } finally {
        flushSync(() => root.unmount());
        localStorage.clear();
        window.history.replaceState({}, '', '/');
      }
    }
  );

  it('preserves the persisted global selection through a legacy redirect and inline editors', async () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
    window.history.replaceState({}, '', '/projects/new/settings');
    const container = document.createElement('div');
    const root = createRoot(container);
    const selected: { selectedProjectSlug?: string; selectedProjectId?: string } = {};
    try {
      await act(() =>
        root.render(
          <MemoryRouter initialEntries={['/projects/new/settings']}>
            <NavigationHarness selected={selected} />
            <Routes>
              <Route path="/projects/:slug/settings" element={<ProjectSettingsRedirect />} />
              <Route path="/admin/:section" element={<AdminDashboardPage />} />
            </Routes>
          </MemoryRouter>
        )
      );
      expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe('new');
      expect(selected.selectedProjectSlug).toBe('alpha');
      expect(selected.selectedProjectId).toBe('alpha-id');
      expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('alpha');
    } finally {
      await act(() => root.unmount());
      localStorage.clear();
      window.history.replaceState({}, '', '/');
    }
  });

  it.each(['', 'missing', 'alpha'])(
    'resolves the global fallback independently of scoped settings with stored=%s',
    async (stored) => {
      localStorage.clear();
      if (stored) {
        localStorage.setItem(SELECTED_PROJECT_KEY, stored);
      }
      window.history.replaceState({}, '', '/projects/new/settings');
      const root = createRoot(document.createElement('div'));
      const selected: { selectedProjectSlug?: string; selectedProjectId?: string } = {};
      try {
        await act(async () =>
          root.render(
            createElement(
              MemoryRouter,
              { initialEntries: ['/projects/new/settings'] },
              createElement(NavigationHarness, { selected })
            )
          )
        );
        expect(selected.selectedProjectSlug).toBe('alpha');
        expect(selected.selectedProjectId).toBe('alpha-id');
        expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('alpha');
      } finally {
        flushSync(() => root.unmount());
        localStorage.clear();
        window.history.replaceState({}, '', '/');
      }
    }
  );

  it('selects and persists the URL project instead of the stored or first project', () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
    window.history.replaceState({}, '', '/projects/new/workspaces');
    const container = document.createElement('div');
    const root = createRoot(container);
    const selected: {
      selectedProjectSlug?: string;
      selectedProjectId?: string;
      reviewCount?: number;
    } = {};
    try {
      flushSync(() =>
        root.render(
          createElement(
            MemoryRouter,
            {
              initialEntries: ['/projects/new/workspaces'],
            },
            createElement(NavigationHarness, { selected })
          )
        )
      );
      expect(selected.reviewCount).toBe(1);
      expect(mocks.reviewQuery).toHaveBeenLastCalledWith(
        { projectId: 'new-id' },
        expect.objectContaining({ enabled: true, staleTime: 30_000 })
      );
      expect(selected.selectedProjectSlug).toBe('new');
      expect(selected.selectedProjectId).toBe('new-id');
      expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('new');
      expect(mocks.listForProject).toHaveBeenLastCalledWith(
        { projectId: 'new-id' },
        expect.objectContaining({ enabled: true })
      );
      // The app-load sweep is automatic, so it must not force GitHub refreshes.
      expect(mocks.mutate).toHaveBeenLastCalledWith({ projectId: 'new-id', force: false });
    } finally {
      flushSync(() => root.unmount());
      localStorage.clear();
      window.history.replaceState({}, '', '/');
    }
  });
});

it.each([
  [
    'archived',
    { id: 'archived-id', slug: 'archived', githubOwner: 'o', githubRepo: 'new' },
    true,
    1,
  ],
  ['local', { id: 'local-id', slug: 'local', githubOwner: null, githubRepo: null }, false, 0],
  ['pending', undefined, false, 0],
])(
  'scopes URL %s before saved selection and without an active project match',
  (slug, project, enabled, count) => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
    window.history.replaceState({}, '', '/');
    mocks.getBySlug.mockReturnValue({ data: project });
    const root = createRoot(document.createElement('div'));
    const selected: { reviewCount?: number } = {};
    try {
      flushSync(() =>
        root.render(
          createElement(
            MemoryRouter,
            { initialEntries: [`/projects/${slug}/reviews`] },
            createElement(NavigationHarness, { selected })
          )
        )
      );
      expect(selected.reviewCount).toBe(count);
      expect(mocks.reviewQuery).toHaveBeenCalledWith(
        { projectId: project?.id ?? '' },
        expect.objectContaining({ enabled })
      );
      expect(
        mocks.reviewQuery.mock.calls.some(
          ([input, options]) => input.projectId === 'alpha-id' && options.enabled
        )
      ).toBe(false);
    } finally {
      flushSync(() => root.unmount());
      localStorage.clear();
    }
  }
);

it('refreshes project review cache when repository metadata changes on the same project', () => {
  mocks.resetReviews.mockClear();
  window.history.replaceState({}, '', '/');
  const root = createRoot(document.createElement('div'));
  const selected: { reviewCount?: number } = {};
  const tree = () =>
    createElement(
      MemoryRouter,
      { initialEntries: ['/projects/new/reviews'] },
      createElement(NavigationHarness, { selected })
    );
  try {
    flushSync(() => root.render(tree()));
    expect(selected.reviewCount).toBe(1);
    mocks.getBySlug.mockReturnValue({
      data: { id: 'new-id', slug: 'new', githubOwner: 'changed', githubRepo: 'new' },
    });
    flushSync(() => root.render(tree()));
    expect(selected.reviewCount).toBe(0);
    expect(mocks.resetReviews).toHaveBeenCalledWith({ projectId: 'new-id' });
  } finally {
    flushSync(() => root.unmount());
  }
});

it('does not treat initial project metadata without an ID as a previous scope', () => {
  mocks.resetReviews.mockClear();
  mocks.getBySlug.mockReturnValue({ data: { success: true } });
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  const onUncaughtError = vi.fn();
  const root = createRoot(document.createElement('div'), { onUncaughtError });
  const selected: { reviewCount?: number } = {};
  try {
    flushSync(() =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/projects/archived-owner/agents/requested-agent'] },
          createElement(NavigationHarness, { selected })
        )
      )
    );
    expect(onUncaughtError).not.toHaveBeenCalled();
    expect(selected.reviewCount).toBe(0);
    expect(mocks.resetReviews).not.toHaveBeenCalled();
    expect(mocks.reviewQuery).toHaveBeenLastCalledWith(
      { projectId: '' },
      expect.objectContaining({ enabled: false })
    );
  } finally {
    flushSync(() => root.unmount());
    localStorage.clear();
  }
});

it('keeps count queries disabled until the project menu requests a refresh', async () => {
  mocks.projectListQuery.mockClear();
  mocks.refetchBoardCounts.mockClear();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter>
          <NavigationHarness selected={{}} />
        </MemoryRouter>
      )
    );
    expect(mocks.projectListQuery).toHaveBeenCalledWith(
      { isArchived: false, includeBoardCounts: true },
      { enabled: false }
    );
    expect(mocks.refetchBoardCounts).not.toHaveBeenCalled();
    await act(() => {
      container.querySelector('button')?.click();
    });
    expect(mocks.refetchBoardCounts).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    localStorage.clear();
  }
});
