import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
// @vitest-environment jsdom
import { trpc } from '@/client/lib/trpc';

const mocks = vi.hoisted(() => ({
  listForProject: vi.fn(() => ({ data: { workspaces: [], reviewCount: 0 } })),
  mutate: vi.fn(),
  getBySlug: vi.fn(),
  reviewQuery: vi.fn(),
  resetReviews: vi.fn(),
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
    project: {
      getBySlug: { useQuery: mocks.getBySlug },
      list: {
        useQuery: () => ({
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
        }),
      },
    },
    workspace: {
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
  return null;
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
  it.each(['/projects/new', '/projects/new/'])('keeps %s as the project creation route', (path) => {
    expect(getProjectSlugFromPath(path)).toBeNull();
  });

  it.each(['/projects/new/workspaces', '/projects/new/settings', '/projects/new/workspaces/w1'])(
    'recognizes the project slug in %s',
    (path) => {
      expect(getProjectSlugFromPath(path)).toBe('new');
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
