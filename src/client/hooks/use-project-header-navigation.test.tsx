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
      <output>{location.pathname}</output>
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
    ['/agents/task-1', 'Beta', '/agents', 'beta'],
    ['/agents', 'Beta', '/agents', 'beta'],
    ['/agents/task-1', 'Current', '/agents', 'alpha'],
    ['/projects/alpha/workspaces/workspace-1', 'Beta', '/projects/beta/workspaces', 'beta'],
    ['/reviews', 'Beta', '/projects/beta/workspaces', 'beta'],
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
    expect(selectProjectSlug).toHaveBeenCalledWith(slug);
    await act(() => root.unmount());
  });
});
