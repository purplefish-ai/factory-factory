// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSelectorDropdown } from '@/client/components/project-selector';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import type { WorkspaceSummary } from '@/shared/workspace-summary';
import { useProjectHeaderNavigation } from './use-project-header-navigation';

const selectProjectSlug = vi.hoisted(() => vi.fn());
const navState = vi.hoisted(() => ({
  workspaces: undefined as WorkspaceSummary<Date>[] | undefined,
}));
vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
  useAppNavigationDataContext: () => ({
    projects: [{ id: 'alpha', slug: 'alpha', name: 'Alpha' }],
    selectedProjectSlug: 'alpha',
    selectProjectSlug,
    serverWorkspaces: navState.workspaces,
  }),
}));

function HeaderSwitch() {
  const { handleProjectChange, handleCurrentProjectSelect } = useProjectHeaderNavigation();
  const location = useLocation();
  return (
    <>
      <button onClick={() => handleProjectChange('beta')}>Beta</button>
      <button onClick={handleCurrentProjectSelect}>Current</button>
      <button onClick={() => handleProjectChange('__create__')}>Create</button>
      <button onClick={() => handleProjectChange('__manage__')}>Manage</button>
      <output>
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe('explicit header project navigation', () => {
  it.each([
    [
      '/projects/alpha/agents/task-1?kind=event&agent=old',
      'Beta',
      '/projects/beta/agents?kind=event',
      'beta',
    ],
    ['/projects/alpha/agents?kind=event', 'Beta', '/projects/beta/agents?kind=event', 'beta'],
    ['/projects/alpha/reviews?kind=event', 'Beta', '/projects/beta/reviews', 'beta'],
    ['/projects/alpha/agents/task-1?agent=old', 'Beta', '/projects/beta/agents', 'beta'],
    ['/projects/alpha/agents', 'Beta', '/projects/beta/agents', 'beta'],
    ['/projects/alpha/agents/task-1', 'Current', '/projects/alpha/workspaces', 'alpha'],
    ['/projects/alpha/workspaces/workspace-1', 'Beta', '/projects/beta/workspaces', 'beta'],
    ['/projects/alpha/reviews?repo=old&pr=12', 'Beta', '/projects/beta/reviews', 'beta'],
    ['/projects/alpha/workspaces', 'Beta', '/projects/beta/workspaces', 'beta'],
    ['/projects/archived/agents/task', 'Current', '/projects/archived/workspaces', 'archived'],
    ['/projects/alpha/agents', 'Create', '/projects/new', ''],
    ['/projects/alpha/reviews', 'Manage', '/projects', ''],
  ])('switches from %s using %s', async (from, button, destination, slug) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() =>
      root.render(
        createElement(MemoryRouter, { initialEntries: [from] }, createElement(HeaderSwitch))
      )
    );
    await act(() =>
      [...container.querySelectorAll('button')]
        .find((entry) => entry.textContent === button)
        ?.click()
    );
    expect(container.querySelector('output')?.textContent).toBe(destination);
    if (slug) {
      expect(selectProjectSlug).toHaveBeenCalledWith(slug);
    } else {
      expect(selectProjectSlug).not.toHaveBeenCalled();
    }
    await act(() => root.unmount());
  });
});

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
function HeaderMenuSwitch() {
  const navigation = useProjectHeaderNavigation();
  const location = useLocation();
  return (
    <>
      <ProjectSelectorDropdown
        selectedProjectSlug="alpha"
        onProjectChange={navigation.handleProjectChange}
        onCurrentProjectSelect={navigation.handleCurrentProjectSelect}
        projects={[
          { id: 'a', slug: 'alpha', name: 'Alpha' },
          { id: 'b', slug: 'beta', name: 'Beta' },
        ]}
      />
      <output>
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
it.each(['primary', 'modified'])(
  'preserves the event-agent section through %s menu activation',
  async (activation) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const from = '/projects/alpha/agents/event-1?kind=event&agent=old';
    try {
      await act(() =>
        root.render(
          <MemoryRouter initialEntries={[from]}>
            <HeaderMenuSwitch />
          </MemoryRouter>
        )
      );
      await act(() =>
        container
          .querySelector('[aria-label^="Open project menu"]')
          ?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
          )
      );
      const link = document.querySelector<HTMLAnchorElement>(
        '[role="menuitem"][href^="/projects/beta/"]'
      );
      expect(link).not.toBeNull();
      expect(link?.getAttribute('href')).toBe('/projects/beta/agents?kind=event');
      if (activation === 'modified') {
        let nativeNavigationAvailable = false;
        document.addEventListener(
          'click',
          (event) => {
            nativeNavigationAvailable = !event.defaultPrevented;
            event.preventDefault();
          },
          { once: true }
        );
        await act(() =>
          link?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
          )
        );
        expect(nativeNavigationAvailable).toBe(true);
        expect(selectProjectSlug).not.toHaveBeenCalled();
        expect(container.querySelector('output')?.textContent).toBe(from);
      } else {
        await act(() => link?.click());
        expect(selectProjectSlug).toHaveBeenCalledWith('beta');
        expect(container.querySelector('output')?.textContent).toBe(
          '/projects/beta/agents?kind=event'
        );
      }
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

function Counts() {
  const { projects } = useProjectHeaderNavigation();
  const boardCounts = projects?.find((project) => project.slug === 'alpha')?.boardCounts;
  return (
    <output>
      {boardCounts ? `Working ${boardCounts.working} Waiting ${boardCounts.waiting}` : 'Loading'}
    </output>
  );
}
it.each([
  ['/projects/alpha/workspaces', true, 'Working 1 Waiting 1'],
  ['/projects/alpha/workspaces', false, 'Loading'],
])(
  'fills the selected project row from loaded workspaces at %s (%s)',
  async (path, loaded, expected) => {
    navState.workspaces = loaded
      ? (['WORKING', 'WAITING', 'DONE'] as const).map((kanbanColumn, index) => ({
          ...createOptimisticWorkspaceSummary({
            id: String(index),
            projectId: 'alpha',
            name: 'Workspace',
            ratchetEnabled: true,
          }),
          kanbanColumn,
        }))
      : undefined;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <MemoryRouter initialEntries={[path]}>
            <Counts />
          </MemoryRouter>
        )
      );
      expect(container.textContent).toBe(expected);
    } finally {
      await act(() => root.unmount());
      navState.workspaces = undefined;
    }
  }
);
