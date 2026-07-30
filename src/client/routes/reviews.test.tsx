// @vitest-environment jsdom

import { act, createElement, forwardRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRWithFullDetails } from '@/shared/github-types';
import ReviewsPage from './reviews';

const listProjectsMock = vi.fn();
const listReviewRequestsMock = vi.fn();

type SubmitReviewVariables = {
  repo: string;
  number: number;
  action: 'approve';
};

const reviewMocks = vi.hoisted(() => ({
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
  useSearchParams: () => [new URLSearchParams()],
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

vi.mock('@/client/components/pr-detail-panel', () => ({
  PRDetailPanel: ({ pr, onApprove }: { pr: PRWithFullDetails | null; onApprove: () => void }) =>
    createElement(
      'div',
      null,
      createElement(
        'span',
        { 'data-testid': 'detail-decision' },
        pr ? `${pr.number}:${pr.reviewDecision ?? 'NONE'}` : 'No PR'
      ),
      createElement('button', { onClick: onApprove, type: 'button' }, 'Approve')
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
  Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetHeader: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => createElement('div', null, 'skeleton'),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
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
      client: { prReview: { getDiff: { query: vi.fn() } } },
    }),
    project: {
      list: {
        useQuery: () => listProjectsMock(),
      },
    },
    prReview: {
      listReviewRequests: {
        useQuery: () => listReviewRequestsMock(),
      },
      getPRDetails: {
        useQuery: ({ repo, number }: { repo: string; number: number }) => ({
          data: reviewMocks.detailsByKey.get(`${repo}#${number}`),
        }),
      },
      submitReview: {
        useMutation: (options: {
          onSuccess: (data: { success: boolean }, variables: SubmitReviewVariables) => void;
        }) => {
          reviewMocks.submitReviewMutationOptions = options;
          return {
            mutate: reviewMocks.submitReviewMutate,
            isPending: false,
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
  reviewMocks.detailsByKey.clear();
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

describe('ReviewsPage header', () => {
  it('renders workspaces back link in header when a project exists', () => {
    listProjectsMock.mockReturnValue({ data: [{ slug: 'alpha' }] });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(ReviewsPage));
    });

    const link = container.querySelector('a[href="/projects/alpha/workspaces"]');
    expect(link).not.toBeNull();

    root.unmount();
  });

  it('does not render workspaces back link when no project exists', () => {
    listProjectsMock.mockReturnValue({ data: [] });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(ReviewsPage));
    });

    const link = container.querySelector('a[href*="/workspaces"]');
    expect(link).toBeNull();

    root.unmount();
  });

  it('renders workspaces back link for empty review list when project exists', () => {
    listProjectsMock.mockReturnValue({ data: [{ slug: 'alpha' }] });
    listReviewRequestsMock.mockReturnValue({ data: { prs: [] }, isLoading: false });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(ReviewsPage));
    });

    const link = container.querySelector('a[href="/projects/alpha/workspaces"]');
    expect(link).not.toBeNull();

    root.unmount();
  });
});

describe('ReviewsPage approval', () => {
  it('updates the submitted PR when selection changes before approval completes', () => {
    listProjectsMock.mockReturnValue({ data: [] });
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
      root.unmount();
    });
  });
});
