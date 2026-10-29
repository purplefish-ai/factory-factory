// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectHeaderNavigation } from './use-project-header-navigation';

const selectProjectSlug = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/use-app-navigation-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/hooks/use-app-navigation-data')>()),
  useAppNavigationDataContext: () => ({ selectedProjectSlug: 'alpha', selectProjectSlug }),
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
