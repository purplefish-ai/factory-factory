// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '@/shared/search';
import { SearchDialog } from './search-dialog';

const result: SearchResult = {
  id: 'session-2',
  kind: 'session',
  title: 'Accessibility review',
  subtitle: 'Factory · Search polish',
  projectSlug: 'factory',
  workspaceId: 'ws-1',
  sessionId: 'session-2',
  archived: false,
};
let root: Root;
beforeAll(() => {
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
});
afterEach(async () => {
  if (root) {
    await act(() => root.unmount());
  }
  document.body.innerHTML = '';
});

async function render(overrides: Partial<React.ComponentProps<typeof SearchDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    results: [result],
    loading: false,
    error: false,
    onRetry: vi.fn(),
    includeArchived: false,
    onIncludeArchivedChange: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<SearchDialog {...props} />));
  return props;
}

describe('SearchDialog', () => {
  it('focuses the search field and selects a result with the keyboard', async () => {
    const props = await render();
    const input = document.querySelector('input');
    expect(document.activeElement).toBe(input);
    expect(document.body.textContent).toContain('Recent');
    await act(() =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).toHaveBeenCalledWith(result);
  });

  it('uses arrow keys to choose another result', async () => {
    const second = { ...result, id: 'session-3', sessionId: 'session-3', title: 'Other review' };
    const props = await render({ results: [result, second] });
    const input = document.querySelector('input');
    await act(() =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    await act(() =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).toHaveBeenCalledWith(second);
  });

  it('never selects stale results while a query is loading', async () => {
    const props = await render({ query: 'different', loading: true });
    expect(document.querySelector('[role="option"]')).toBeNull();
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Searching');
  });

  it('offers retry on failure instead of a misleading empty result', async () => {
    const props = await render({ results: [], error: true });
    expect(document.body.textContent).toContain('Couldn’t search');
    const retry = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Try again'
    );
    await act(() => retry?.click());
    expect(props.onRetry).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('No results');
  });

  it('closes with Escape and exposes an archive toggle', async () => {
    const props = await render({ results: [] });
    const toggle = document.querySelector('button[aria-pressed]');
    await act(() => toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onIncludeArchivedChange).toHaveBeenCalledWith(true);
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
