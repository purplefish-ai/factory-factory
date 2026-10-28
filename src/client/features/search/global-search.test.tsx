// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './global-search';

const query = vi.hoisted(() => vi.fn());
vi.mock('@/client/lib/trpc', () => ({ trpc: { search: { metadata: { useQuery: query } } } }));
let root: Root;
function LocationProbe() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  query.mockReturnValue({
    data: [
      {
        kind: 'session',
        id: 'chat-2',
        title: 'Review',
        subtitle: 'Factory · Search',
        projectSlug: 'factory',
        workspaceId: 'ws',
        sessionId: 'chat-2',
        archived: false,
      },
    ],
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={['/projects/factory/workspaces/ws']}>
        <GlobalSearch />
        <LocationProbe />
      </MemoryRouter>
    )
  );
}
async function key(keyValue: string, modifiers: KeyboardEventInit = {}) {
  await act(() =>
    (document.querySelector('input') ?? window).dispatchEvent(
      new KeyboardEvent('keydown', { key: keyValue, bubbles: true, ...modifiers })
    )
  );
}

describe('GlobalSearch', () => {
  it('keeps archived results read-only and returns to the search', async () => {
    const response = query();
    query.mockReturnValue({
      ...response,
      data: response.data.map((r: { archived: boolean }) => ({ ...r, archived: true })),
    });
    await render();
    await key('k', { ctrlKey: true });
    await key('Enter');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'archived workspace or project'
    );
    expect(document.querySelector('output')?.textContent).toBe('/projects/factory/workspaces/ws');
    const back = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Back to search'
    );
    await act(() => back?.click());
    expect(document.querySelector('input')).not.toBeNull();
  });
  it('opens with either platform shortcut and navigates to the exact conversation', async () => {
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await key('k', { ctrlKey: true });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await key('Enter');
    expect(document.querySelector('output')?.textContent).toBe(
      '/projects/factory/workspaces/ws?session=chat-2'
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await key('k', { metaKey: true });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('debounces typing and hides old results before the new request starts', async () => {
    vi.useFakeTimers();
    await render();
    await key('k', { metaKey: true });
    const input = document.querySelector('input');
    if (!input) {
      throw new Error('Missing search input');
    }
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'new');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('[role="option"]')).toBeNull();
    await key('Enter');
    expect(document.querySelector('output')?.textContent).toBe('/projects/factory/workspaces/ws');
    expect(query.mock.lastCall?.[0].query).toBe('');
    await act(() => vi.advanceTimersByTime(150));
    expect(query.mock.lastCall?.[0].query).toBe('new');
    await key('k', { metaKey: true });
    await key('k', { metaKey: true });
    expect(document.querySelector('input')?.value).toBe('');
  });
});
