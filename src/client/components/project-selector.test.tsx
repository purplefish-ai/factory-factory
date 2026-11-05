// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSelectorDropdown } from './project-selector';
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-overlay-positioning', () => ({ useOverlayPositioning: () => ({}) }));
const change = vi.fn();
const current = vi.fn();
const retry = vi.fn();
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});
async function render(path = '/projects/alpha/reviews', open = true) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <ProjectSelectorDropdown
          selectedProjectSlug="alpha"
          projects={[
            { id: 'a', slug: 'alpha', name: 'Alpha' },
            { id: 'b', slug: 'beta', name: 'Beta' },
          ]}
          onProjectChange={change}
          onCurrentProjectSelect={current}
          onRetryProjects={retry}
        />
      </MemoryRouter>
    )
  );
  cleanup = async () => {
    await act(() => root.unmount());
    container.remove();
  };
  const trigger = container.querySelector('button[aria-label="Open project menu"]');
  expect(trigger).not.toBeNull();
  if (!open) {
    return container;
  }
  await act(() =>
    trigger?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    )
  );
  return container;
}
function item(label: string) {
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label
  );
  expect(entry, `Missing menuitem ${label}`).toBeDefined();
  return entry!;
}
it('uses section-preserving project links and real command menu items', async () => {
  await render();
  expect(item('Beta').getAttribute('href')).toBe('/projects/beta/reviews');
  expect(item('Alpha').getAttribute('href')).toBe('/projects/alpha/workspaces');
  expect(item('+ Create project').getAttribute('href')).toBe('/projects/new');
  expect(item('Manage projects…').getAttribute('href')).toBe('/projects');
});
it('switches using keyboard activation', async () => {
  await render();
  await act(() =>
    item('Beta').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  );
  expect(change).toHaveBeenCalledWith('beta');
});
it.each([
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
])('preserves native modified project clicks %j', async (options) => {
  await render();
  // Block native navigation after React sees the event, without changing its input.
  const preventNavigation = (event: Event) => event.preventDefault();
  document.addEventListener('click', preventNavigation, { once: true });
  await act(() =>
    item('Beta').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ...options })
    )
  );
  expect(change).not.toHaveBeenCalled();
});
it('retries project loading without switching projects', async () => {
  await render();
  await act(() => item('Retry projects').click());
  expect(retry).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});

it('opens the menu from the project name without navigating to the board', async () => {
  const container = await render('/projects/alpha/reviews', false);
  const name = [...container!.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Alpha')
  );
  expect(name).toBeDefined();
  await act(() =>
    name?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    )
  );
  expect(item('Beta')).toBeDefined();
  expect(current).not.toHaveBeenCalled();
});
