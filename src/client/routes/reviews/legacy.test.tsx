// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { actFlushSync } from '@/test-utils/react-act';
import LegacyReviewsRoute from './legacy';

const mocks = vi.hoisted(() => ({ navigation: vi.fn(), archived: vi.fn() }));
vi.mock('@/client/hooks/use-app-navigation-data', () => ({
  useAppNavigationDataContext: mocks.navigation,
}));
vi.mock('@/client/components/project-header', () => ({ ProjectHeader: () => null }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      list: { useQuery: mocks.archived },
      getBySlug: { useQuery: () => ({}) },
    },
  },
}));
const projects = [
  { id: 'a', slug: 'alpha', name: 'Alpha', githubOwner: 'owner', githubRepo: 'repo' },
  { id: 'b', slug: 'beta', name: 'Beta', githubOwner: 'owner', githubRepo: 'repo' },
  { id: 'c', slug: 'gamma', name: 'Gamma', githubOwner: 'other', githubRepo: 'repo' },
];
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  vi.clearAllMocks();
  localStorage.clear();
  mocks.navigation.mockReturnValue({
    projects,
    selectedProjectSlug: 'beta',
    selectedProjectId: 'b',
  });
  mocks.archived.mockReturnValue({ data: [] });
});
function Destination() {
  const location = useLocation();
  return createElement('output', null, location.pathname + location.search);
}
function render(search: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const tree = () =>
    createElement(
      MemoryRouter,
      { initialEntries: [`/reviews${search}`] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/reviews', element: createElement(LegacyReviewsRoute) }),
        createElement(Route, { path: '*', element: createElement(Destination) })
      )
    );
  actFlushSync(() => root.render(tree()));
  return {
    container,
    rerender: () => actFlushSync(() => root.render(tree())),
    unmount: () => actFlushSync(() => root.unmount()),
  };
}
it('redirects a plain legacy link to the selected project', () => {
  const view = render('');
  expect(view.container.textContent).toBe('/projects/beta/reviews');
  view.unmount();
});
it.each([
  ['?repo=OWNER/REPO&pr=42', '/projects/beta/reviews?repo=OWNER/REPO&pr=42'],
  ['?repo=OTHER/REPO&pr=7', '/projects/gamma/reviews?repo=OTHER/REPO&pr=7'],
])('resolves configured repository ownership for %s', (search, destination) => {
  const view = render(search);
  expect(view.container.textContent).toBe(destination);
  view.unmount();
});
it('waits for archived owner resolution when no active project matches', () => {
  mocks.archived.mockReturnValue({ isLoading: true });
  const view = render('?repo=archived/repo&pr=9');
  expect(view.container.textContent).toMatch(/Loading/);
  mocks.archived.mockReturnValue({
    data: [{ id: 'old', slug: 'old', githubOwner: 'archived', githubRepo: 'repo' }],
  });
  view.rerender();
  expect(view.container.textContent).toBe('/projects/old/reviews?repo=archived/repo&pr=9');
  view.unmount();
});
it('shows an ownership error for an unconfigured repository', () => {
  const view = render('?repo=unknown/repo&pr=9');
  expect(view.container.textContent).toMatch(/No configured project/);
  expect(view.container.querySelector('output')).toBeNull();
  view.unmount();
});
it('keeps project-list failures retryable without redirecting', () => {
  const retry = vi.fn();
  mocks.navigation.mockReturnValue({ projectsError: new Error('offline'), refetchProjects: retry });
  const view = render('');
  expect(view.container.textContent).toContain('offline');
  actFlushSync(() => view.container.querySelector('button')?.click());
  expect(retry).toHaveBeenCalledOnce();
  view.unmount();
});
