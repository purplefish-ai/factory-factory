// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { GlobalSearch } from './global-search';

const chunk = vi.hoisted(() => {
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
});
vi.mock('@/client/features/kanban', () => chunk.promise);
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    search: {
      metadata: {
        useQuery: () => ({ data: [], isPending: false, isFetching: false, isError: false }),
      },
      githubIssues: {
        useQuery: () => ({
          data: {
            results: [
              {
                kind: 'github_issue',
                id: 'p1:42',
                title: 'Fix search',
                subtitle: 'Factory · Issue #42',
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
              },
            ],
            errors: [],
          },
          isPending: false,
          isFetching: false,
          isError: false,
        }),
      },
    },
  },
}));

it('contains a failed launch chunk and keeps the app and search usable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('reportError', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const uncaught = vi.fn();
  const root = createRoot(container, { onCaughtError: () => undefined, onUncaughtError: uncaught });
  try {
    await act(() =>
      root.render(
        <MemoryRouter>
          <output>App shell</output>
          <GlobalSearch />
        </MemoryRouter>
      )
    );
    await act(() =>
      container
        .querySelector('button[aria-label="Search"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    const input = document.querySelector('input')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '#42');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="option"]')?.textContent).toContain('Fix search')
    );
    await act(() =>
      document
        .querySelector('[role="option"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    await act(() => chunk.reject(new Error('Failed to fetch launch chunk')));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Unable to load issue launch options'
      )
    );
    expect(container.querySelector('output')?.textContent).toBe('App shell');
    expect(uncaught).not.toHaveBeenCalled();
    const close = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Close'
    );
    await act(() => close?.click());
    await act(() =>
      container
        .querySelector('button[aria-label="Search"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(document.querySelector('input')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
