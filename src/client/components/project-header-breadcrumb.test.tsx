// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectHeader } from './project-header';
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => children,
  useAppHeader: vi.fn(),
}));
vi.mock('@/client/hooks/use-project-header-navigation', () => ({
  useProjectHeaderNavigation: () => ({
    projects: [{ id: 'a', slug: 'alpha', name: 'Alpha' }],
    handleProjectChange: vi.fn(),
    handleCurrentProjectSelect: vi.fn(),
  }),
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
it.each([
  ['workspaces', 'Board'],
  ['agents', 'Agents'],
  ['reviews', 'Reviews'],
])('identifies %s as the current section', async (section, label) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/projects/alpha/${section}`]}>
        <ProjectHeader project={{ id: 'a', slug: 'alpha', name: 'Alpha' }} />
      </MemoryRouter>
    )
  );
  expect(
    container.querySelector('[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent
  ).toBe(label);
  await act(() => root.unmount());
});
