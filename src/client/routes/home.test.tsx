// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import HomePage from './home';

const { navigate, query } = vi.hoisted(() => ({
  navigate: vi.fn(),
  query: {
    data: undefined as { slug: string }[] | undefined,
    isLoading: false,
    error: null as Error | null,
  },
}));
vi.mock('react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@/client/lib/trpc', () => ({ trpc: { project: { list: { useQuery: () => query } } } }));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  navigate.mockClear();
  query.data = [{ slug: 'alpha' }, { slug: 'beta' }];
  query.isLoading = false;
  query.error = null;
});
afterEach(() => vi.unstubAllGlobals());
async function render() {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() => root.render(<HomePage />));
  await act(() => root.unmount());
}
it.each([
  ['beta', '/projects/beta'],
  ['deleted-project', '/projects/alpha'],
  ['', '/projects/alpha'],
])('validates saved project %s against the active list', async (stored, expected) => {
  localStorage.setItem(SELECTED_PROJECT_KEY, stored);
  await render();
  expect(navigate).toHaveBeenCalledWith(expected, { replace: true });
});
it('opens onboarding only after loading an empty list', async () => {
  query.data = [];
  await render();
  expect(navigate).toHaveBeenCalledWith('/projects/new', { replace: true });
});
it('waits for projects before redirecting', async () => {
  query.isLoading = true;
  query.data = undefined;
  await render();
  expect(navigate).not.toHaveBeenCalled();
});
it('opens recoverable project errors instead of onboarding', async () => {
  query.data = undefined;
  query.error = new Error('Offline');
  await render();
  expect(navigate).toHaveBeenCalledWith('/projects', { replace: true });
});
