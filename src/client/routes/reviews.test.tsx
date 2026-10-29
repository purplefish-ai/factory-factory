// @vitest-environment jsdom

import { act, createElement, forwardRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRWithFullDetails } from '@/shared/github-types';
import { actFlushSync } from '@/test-utils/react-act';
import ReviewsPage from './reviews';

const projectQueryMock = vi.fn();
let project = {
  id: 'alpha-id',
  slug: 'alpha',
  name: 'Alpha',
  githubOwner: 'org',
  githubRepo: 'repo',
};
let search = '';
let mobile = false;
const listReviewRequestsMock = vi.fn();

type SubmitReviewVariables = {
  repo: string;
  number: number;
  action: 'approve';
};

const reviewMocks = vi.hoisted(() => ({
  approvalPending: false,
  getDiff: vi.fn(),
  detailsQuery: vi.fn(),
  detailsByKey: new Map<string, PRWithFullDetails>(),
  invalidateReviewRequests: vi.fn(),
  submitReviewMutate: vi.fn(),
  submitReviewMutationOptions: undefined as
    | {
        onSuccess: (data: { success: boolean }, variables: SubmitReviewVariables) => void;
      }
    | undefined,
  submittedReviewVariables: undefined as SubmitReviewVariables | undefined,
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
  useSearchParams: () => [new URLSearchParams(search)],
  useParams: () => ({ slug: project.slug }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftExtraSlot: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'header-left-extra' }, children),
  useAppHeader: vi.fn(),
}));

vi.mock('@/client/components/project-header', () => ({
  ProjectHeader: ({ project }: { project: { name: string } }) =>
    createElement('nav', null, project.name),
}));

vi.mock('@/client/components/pr-detail-panel', () => ({
  PRDetailPanel: ({
    pr,
    onApprove,
    onFetchDiff,
    diff,
    diffLoading,
  }: {
    pr: PRWithFullDetails | null;
    onApprove: () => void;
    onFetchDiff: () => void;
    diff: string | null;
    diffLoading: boolean;
  }) =>
    createElement(
      'div',
      null,
      createElement(
        'span',
        { 'data-testid': 'detail-decision' },
        pr ? `${pr.number}:${pr.reviewDecision ?? 'NONE'}` : 'No PR'
      ),
      createElement('button', { onClick: onApprove, type: 'button' }, 'Approve'),
      createElement('button', { onClick: onFetchDiff, type: 'button' }, 'Diff'),
      createElement('span', { 'data-testid': 'diff' }, diffLoading ? 'Loading diff' : diff)
    ),
}));

vi.mock('@/client/components/pr-inbox-item', () => {
  const InboxItem = forwardRef<HTMLButtonElement, { onSelect: () => void; pr: PRWithFullDetails }>(
    function InboxItem({ onSelect, pr }, ref) {
      return createElement(
        'button',
        {
          ref,
          'data-testid': `pr-${pr.number}`,
          onClick: onSelect,
          type: 'button',
        },
        `${pr.number}:${pr.reviewDecision ?? 'NONE'}`
      );
    }
  );

  return {
    PRInboxItem: InboxItem,
  };
});

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? createElement('div', { 'data-testid': 'sheet' }, children) : null,
  SheetContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetHeader: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => createElement('div', null, 'skeleton'),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mobile,
}));

vi.mock('@/client/features/workspace', () => ({
  WorkspacesBackLink: ({ projectSlug }: { projectSlug: string }) =>
    createElement('a', { href: `/projects/${projectSlug}/workspaces` }, 'Workspaces'),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      prReview: {
        listReviewRequests: { invalidate: reviewMocks.invalidateReviewRequests },
      },
      client: { prReview: { getDiff: { query: reviewMocks.getDiff } } },
    }),
    project: {
      getBySlug: { useQuery: () => projectQueryMock() },
      list: { useQuery: () => ({ data: [project] }) },
    },
    prReview: {
      listReviewRequests: {
        useQuery: (...args: unknown[]) => listReviewRequestsMock(...args),
      },
      getPRDetails: {
        useQuery: (...args: unknown[]) => reviewMocks.detailsQuery(...args),
      },
      submitReview: {
        useMutation: (options: {
          onSuccess: (data: { success: boolean }, variables: SubmitReviewVariables) => void;
        }) => {
          reviewMocks.submitReviewMutationOptions = options;
          return {
            mutate: reviewMocks.submitReviewMutate,
            isPending: reviewMocks.approvalPending,
          };
        },
      },
    },
  },
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  project = {
    id: 'alpha-id',
    slug: 'alpha',
    name: 'Alpha',
    githubOwner: 'org',
    githubRepo: 'repo',
  };
  projectQueryMock.mockImplementation(() => ({ data: project }));
  search = '';
  mobile = false;
  reviewMocks.getDiff.mockReset();
  reviewMocks.detailsQuery
    .mockReset()
    .mockImplementation(
      ({ repo, number }: { repo: string; number: number }, options: { enabled: boolean }) => ({
        data: options.enabled ? reviewMocks.detailsByKey.get(`${repo}#${number}`) : undefined,
      })
    );
  reviewMocks.detailsByKey.clear();
  reviewMocks.approvalPending = false;
  reviewMocks.submitReviewMutationOptions = undefined;
  reviewMocks.submittedReviewVariables = undefined;
  reviewMocks.submitReviewMutate.mockImplementation((variables: SubmitReviewVariables) => {
    reviewMocks.submittedReviewVariables = variables;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
  });
  listReviewRequestsMock.mockReturnValue({
    data: {
      prs: [
        {
          number: 1,
          title: 'Test PR',
          url: 'https://example.com/pr/1',
          author: { login: 'alice' },
          repository: { nameWithOwner: 'org/repo' },
          createdAt: '2024-01-01T00:00:00Z',
          isDraft: false,
          reviewDecision: null,
          additions: 1,
          deletions: 1,
          changedFiles: 1,
        },
      ],
    },
    isLoading: false,
  });
});

function makeDetails(number: number, title: string): PRWithFullDetails {
  return {
    number,
    title,
    url: `https://example.com/pr/${number}`,
    author: { login: 'alice' },
    repository: {
      name: 'repo',
      nameWithOwner: 'org/repo',
    },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    isDraft: false,
    state: 'OPEN',
    reviewDecision: null,
    statusCheckRollup: null,
    reviews: [],
    comments: [],
    labels: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    headRefName: 'feature',
    baseRefName: 'main',
    mergeStateStatus: 'UNKNOWN',
  };
}

function mountReviews() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  actFlushSync(() => root.render(createElement(ReviewsPage)));
  return {
    container,
    root,
    render: () => actFlushSync(() => root.render(createElement(ReviewsPage))),
    unmount: () => actFlushSync(() => root.unmount()),
  };
}

function click(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === label
  );
  expect(button).toBeDefined();
  actFlushSync(() => button?.click());
}

describe('project reviews', () => {
  it('queries the canonical project and uses its shared project header', () => {
    const view = mountReviews();
    expect(view.container.querySelector('nav')?.textContent).toBe('Alpha');
    expect(listReviewRequestsMock).toHaveBeenCalledWith(
      { projectId: 'alpha-id' },
      expect.objectContaining({ staleTime: 30_000, enabled: true })
    );
    view.unmount();
  });

  it.each([null, 'repo repo:foreign/repo'])(
    'does not query reviews or details for unlinked/invalid repository %s',
    (repo) => {
      project.githubRepo = repo as string;
      const view = mountReviews();
      expect(view.container.textContent).toMatch(
        /linked GitHub repository|Invalid GitHub repository/
      );
      expect(listReviewRequestsMock.mock.calls.every(([, options]) => !options.enabled)).toBe(true);
      expect(reviewMocks.detailsQuery).not.toHaveBeenCalled();
      view.unmount();
    }
  );

  it('waits for project resolution and exposes retryable project/review errors', () => {
    projectQueryMock.mockReturnValue({ isLoading: true });
    const view = mountReviews();
    expect(listReviewRequestsMock).not.toHaveBeenCalled();
    projectQueryMock.mockReturnValue({ error: new Error('project offline'), refetch: vi.fn() });
    view.render();
    expect(view.container.textContent).toContain('project offline');
    expect(view.container.textContent).toContain('Retry');
    projectQueryMock.mockImplementation(() => ({ data: project }));
    listReviewRequestsMock.mockReturnValue({
      error: new Error('review offline'),
      refetch: vi.fn(),
    });
    view.render();
    expect(view.container.textContent).toContain('review offline');
    view.unmount();
  });

  it.each(['fetch', 'authentication'])(
    'keeps cached reviews non-actionable after %s failure',
    (failure) => {
      listReviewRequestsMock.mockReturnValue({
        data: {
          prs: [makeDetails(1, 'Cached')],
          health: { isInstalled: true, isAuthenticated: failure !== 'authentication' },
        },
        error: failure === 'fetch' ? new Error('offline') : null,
        refetch: vi.fn(),
      });
      const view = mountReviews();
      expect(reviewMocks.detailsQuery.mock.calls.every(([, options]) => !options.enabled)).toBe(
        true
      );
      actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
      expect(reviewMocks.submitReviewMutate).not.toHaveBeenCalled();
      view.unmount();
    }
  );

  it('filters cached rows by full repository identity and rejects foreign deep-link details', () => {
    search = '?repo=foreign/repo&pr=1';
    listReviewRequestsMock.mockReturnValue({
      data: {
        prs: [
          { ...makeDetails(1, 'Foreign'), repository: { nameWithOwner: 'foreign/repo' } },
          makeDetails(2, 'Local'),
        ],
      },
    });
    const view = mountReviews();
    expect(view.container.querySelector('[data-testid="pr-1"]')).toBeNull();
    expect(
      reviewMocks.detailsQuery.mock.calls.every(
        ([input, options]) => !options.enabled || input.repo === 'org/repo'
      )
    ).toBe(true);
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 2,
      action: 'approve',
    });
    view.unmount();
  });

  it('applies a case-insensitive deep link once without overriding later selection', () => {
    search = '?repo=ORG/REPO&pr=2';
    const prs = [makeDetails(1, 'A'), makeDetails(2, 'B')];
    listReviewRequestsMock.mockReturnValue({ data: { prs } });
    const view = mountReviews();
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 2,
      action: 'approve',
    });
    click(view.container, '1:NONE');
    listReviewRequestsMock.mockReturnValue({ data: { prs: [...prs] } });
    view.render();
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 1,
      action: 'approve',
    });
    view.unmount();
  });

  it('selects a deep-link target when it appears in a later refresh', () => {
    search = '?repo=org/repo&pr=2';
    listReviewRequestsMock.mockReturnValue({ data: { prs: [makeDetails(1, 'A')] } });
    const view = mountReviews();
    listReviewRequestsMock.mockReturnValue({
      data: { prs: [makeDetails(1, 'A'), makeDetails(2, 'B')] },
    });
    view.render();
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 2,
      action: 'approve',
    });
    view.unmount();
  });

  it.each(['row', 'keyboard'])(
    'keeps a manual %s selection when the deep-link target arrives later',
    (method) => {
      search = '?repo=org/repo&pr=2';
      listReviewRequestsMock.mockReturnValue({
        data: { prs: [makeDetails(1, 'A'), makeDetails(3, 'C')] },
      });
      const view = mountReviews();
      if (method === 'row') {
        click(view.container, '3:NONE');
      } else {
        actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
      }
      listReviewRequestsMock.mockReturnValue({
        data: { prs: [makeDetails(1, 'A'), makeDetails(3, 'C'), makeDetails(2, 'B')] },
      });
      view.render();
      click(view.container, 'Approve');
      expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
        repo: 'org/repo',
        number: 3,
        action: 'approve',
      });
      view.unmount();
    }
  );

  it('moves immediately from the bounded selection after the review list shrinks', () => {
    listReviewRequestsMock.mockReturnValue({
      data: { prs: [1, 2, 3, 4].map((number) => makeDetails(number, `PR ${number}`)) },
    });
    const view = mountReviews();
    click(view.container, '4:NONE');
    listReviewRequestsMock.mockReturnValue({
      data: { prs: [1, 2].map((number) => makeDetails(number, `PR ${number}`)) },
    });
    view.render();
    actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })));
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 1,
      action: 'approve',
    });
    view.unmount();
  });

  it('keeps the selection valid when keyboard navigation precedes the first reviews', () => {
    listReviewRequestsMock.mockReturnValue({ data: { prs: [] } });
    const view = mountReviews();
    actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    listReviewRequestsMock.mockReturnValue({ data: { prs: [makeDetails(1, 'A')] } });
    view.render();
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 1,
      action: 'approve',
    });
    view.unmount();
  });

  it('does not accept numeric-prefix PR links', () => {
    search = '?repo=org/repo&pr=2suffix';
    listReviewRequestsMock.mockReturnValue({
      data: { prs: [makeDetails(1, 'A'), makeDetails(2, 'B')] },
    });
    const view = mountReviews();
    click(view.container, 'Approve');
    expect(reviewMocks.submitReviewMutate).toHaveBeenLastCalledWith({
      repo: 'org/repo',
      number: 1,
      action: 'approve',
    });
    view.unmount();
  });

  it('resets details, diff and mobile sheet across project/repository changes and ignores late completion', async () => {
    mobile = true;
    let resolveDiff: ((value: { diff: string }) => void) | undefined;
    reviewMocks.getDiff.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDiff = resolve;
        })
    );
    reviewMocks.detailsByKey.set('org/repo#1', makeDetails(1, 'Old details'));
    const view = mountReviews();
    click(view.container, '1:NONE');
    click(view.container, 'Diff');
    expect(view.container.querySelector('[data-testid="diff"]')?.textContent).toBe('Loading diff');
    project = { ...project, id: 'beta-id', slug: 'beta', name: 'Beta' };
    view.render();
    expect(view.container.querySelector('[data-testid="sheet"]')).toBeNull();
    click(view.container, '1:NONE');
    await act(async () => resolveDiff?.({ diff: 'OLD DIFF' }));
    expect(view.container.textContent).not.toContain('OLD DIFF');
    project = { ...project, githubRepo: 'different' };
    view.render();
    expect(view.container.querySelector('[data-testid="sheet"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="pr-1"]')).toBeNull();
    view.unmount();
  });
});

describe('ReviewsPage approval', () => {
  it('ignores repeated approve shortcuts while a review submission is pending', () => {
    const view = mountReviews();
    actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(reviewMocks.submitReviewMutate).toHaveBeenCalledTimes(1);
    reviewMocks.approvalPending = true;
    view.render();
    actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(reviewMocks.submitReviewMutate).toHaveBeenCalledTimes(1);
    reviewMocks.approvalPending = false;
    view.render();
    actFlushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(reviewMocks.submitReviewMutate).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('updates the submitted PR when selection changes before approval completes', () => {
    listReviewRequestsMock.mockReturnValue({
      data: {
        prs: [
          {
            number: 1,
            title: 'PR A',
            url: 'https://example.com/pr/1',
            author: { login: 'alice' },
            repository: { nameWithOwner: 'org/repo' },
            createdAt: '2024-01-01T00:00:00Z',
            isDraft: false,
            reviewDecision: null,
            additions: 1,
            deletions: 1,
            changedFiles: 1,
          },
          {
            number: 2,
            title: 'PR B',
            url: 'https://example.com/pr/2',
            author: { login: 'bob' },
            repository: { nameWithOwner: 'org/repo' },
            createdAt: '2024-01-02T00:00:00Z',
            isDraft: false,
            reviewDecision: null,
            additions: 2,
            deletions: 2,
            changedFiles: 2,
          },
        ],
      },
      isLoading: false,
    });
    reviewMocks.detailsByKey.set('org/repo#1', makeDetails(1, 'PR A'));
    reviewMocks.detailsByKey.set('org/repo#2', makeDetails(2, 'PR B'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    void act(() => {
      root.render(createElement(ReviewsPage));
    });

    const approveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Approve'
    );
    expect(approveButton).toBeDefined();

    void act(() => {
      approveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reviewMocks.submittedReviewVariables).toEqual({
      repo: 'org/repo',
      number: 1,
      action: 'approve',
    });

    const prB = container.querySelector<HTMLButtonElement>('[data-testid="pr-2"]');
    expect(prB).not.toBeNull();
    void act(() => {
      prB?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mutationOptions = reviewMocks.submitReviewMutationOptions;
    const submittedVariables = reviewMocks.submittedReviewVariables;
    expect(mutationOptions).toBeDefined();
    expect(submittedVariables).toBeDefined();

    void act(() => {
      if (mutationOptions && submittedVariables) {
        mutationOptions.onSuccess({ success: true }, submittedVariables);
      }
    });

    expect(container.querySelector('[data-testid="pr-1"]')?.textContent).toBe('1:APPROVED');
    expect(container.querySelector('[data-testid="pr-2"]')?.textContent).toBe('2:NONE');
    expect(container.querySelector('[data-testid="detail-decision"]')?.textContent).toBe('2:NONE');
    expect(reviewMocks.invalidateReviewRequests).toHaveBeenCalledTimes(1);

    void act(() => {
      actFlushSync(() => root.unmount());
    });
  });
});
