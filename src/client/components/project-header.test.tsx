// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectHeaderNavigation } from './project-header';

vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
  useAppNavigationDataContext: () => ({
    projects: [{ id: 'active', slug: 'active', name: 'Active project' }],
    selectedProjectSlug: 'active',
    selectProjectSlug: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
it('shows the explicit archived project alongside active project choices without section tabs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <MemoryRouter initialEntries={['/projects/archived/agents/task?old=1']}>
          <ProjectHeaderNavigation
            project={{ id: 'archived-id', slug: 'archived', name: 'Archived owner' }}
          />
        </MemoryRouter>
      )
    );
    expect(
      container.querySelector('button[aria-label="Open Archived owner workspaces"]')
    ).not.toBeNull();
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    await act(() =>
      container
        .querySelector('[role="combobox"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent
    );
    expect(options).toContain('Archived owner');
    expect(options).toContain('Active project');
    expect(options).toContain('+ Create project');
    expect(options).toContain('Manage projects...');
  } finally {
    await act(() => root.unmount());
  }
});
