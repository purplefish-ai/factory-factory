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
  it('keeps local results selectable while GitHub issues load or fail', async () => {
    const props = await render({
      githubIssues: { results: [], loading: true, error: false, onRetry: vi.fn() },
    });
    expect(document.querySelector('[role="option"]')?.textContent).toContain('Accessibility');
    expect(document.body.textContent).toContain('Searching GitHub');
    await act(() =>
      root.render(
        <SearchDialog
          {...props}
          githubIssues={{ results: [], loading: false, error: true, onRetry: vi.fn() }}
        />
      )
    );
    expect(document.body.textContent).toContain('Couldn’t search GitHub');
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).toHaveBeenCalledWith(result);
  });

  it('offers GitHub issue results as Start issue actions with keyboard selection', async () => {
    const issue: SearchResult = {
      kind: 'github_issue',
      id: 'p1:42',
      title: 'Fix search',
      subtitle: 'Factory · org/repo · Issue #42',
      projectId: 'p1',
      projectSlug: 'factory',
      workspaceId: null,
      sessionId: null,
      archived: false,
      githubIssue: {
        number: 42,
        title: 'Fix search',
        body: 'Details',
        url: 'https://github.com/org/repo/issues/42',
        state: 'OPEN',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'martin' },
      },
    };
    const props = await render({
      results: [],
      query: '#42',
      githubIssues: { results: [issue], loading: false, error: false, onRetry: vi.fn() },
    });
    expect(document.querySelector('[role="option"]')?.textContent).toContain('Start issue');
    expect(document.body.textContent).not.toContain('No results found');
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).toHaveBeenCalledWith(issue);
  });

  it.each(['button[aria-pressed]', 'button[aria-label="Close search"]'])(
    'keeps Enter on the focused control %s',
    async (selector) => {
      const props = await render();
      const button = document.querySelector(selector);
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      await act(() => button?.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(props.onSelect).not.toHaveBeenCalled();
    }
  );

  it('resets keyboard selection when reopening cached results', async () => {
    const second = { ...result, id: 'second', sessionId: 'second' };
    const props = await render({ results: [result, second] });
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    await act(() => root.render(<SearchDialog {...props} open={false} />));
    await act(() => root.render(<SearchDialog {...props} open />));
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).toHaveBeenCalledWith(result);
  });

  it('preserves keyboard selection when GitHub finishes loading', async () => {
    const second = { ...result, id: 'second', sessionId: 'second' };
    const props = await render({
      results: [result, second],
      githubIssues: { results: [], loading: true, error: false, onRetry: vi.fn() },
    });
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    await act(() =>
      root.render(
        <SearchDialog
          {...props}
          githubIssues={{ results: [], loading: false, error: false, onRetry: vi.fn() }}
        />
      )
    );
    await act(() =>
      document
        .querySelector('input')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(props.onSelect).toHaveBeenCalledWith(second);
  });

  it('shows a highlighted snippet for a metadata-only match', async () => {
    await render({
      query: 'omnibox',
      results: [{ ...result, matchSnippet: 'Add Omnibox support' }],
    });
    expect(document.querySelector('mark')?.textContent).toBe('Omnibox');
  });

  it('highlights the longest overlapping term and canonically equivalent Unicode', async () => {
    await render({
      query: 'feat feature e\u0301clair',
      results: [{ ...result, title: 'feature Éclair' }],
    });
    expect(Array.from(document.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual([
      'feature',
      'Éclair',
    ]);
  });
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

  it('allows Enter on Try again to activate retry instead of cmdk selection', async () => {
    const props = await render({ results: [], error: true });
    const retry = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again'
    );
    expect(retry).toBeDefined();
    retry?.focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(() => {
      retry?.dispatchEvent(event);
      // jsdom does not implement the browser's default Enter-to-click activation.
      if (!event.defaultPrevented) {
        retry?.click();
      }
    });
    expect(event.defaultPrevented).toBe(false);
    expect(props.onRetry).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
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
