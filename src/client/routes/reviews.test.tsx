// @vitest-environment jsdom

import { createElement, forwardRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewsPage from './reviews';

const listProjectsMock = vi.fn();
const listReviewRequestsMock = vi.fn();

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
  PRDetailPanel: () => createElement('div', null, 'PR Detail Panel'),
}));

vi.mock('@/client/components/pr-inbox-item', () => {
  const InboxItem = forwardRef<HTMLButtonElement, { onSelect: () => void }>(function InboxItem(
    { onSelect },
    ref
  ) {
    return createElement('button', { ref, onClick: onSelect, type: 'button' }, 'PR item');
  });

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

vi.mock('@/components/workspace', () => ({
  WorkspacesBackLink: ({ projectSlug }: { projectSlug: string }) =>
    createElement('a', { href: `/projects/${projectSlug}/workspaces` }, 'Workspaces'),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      prReview: { listReviewRequests: { invalidate: vi.fn() } },
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
        useQuery: () => ({ data: undefined }),
      },
      submitReview: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

beforeEach(() => {
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
