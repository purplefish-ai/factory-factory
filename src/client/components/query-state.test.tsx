// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryState, type QueryStateQuery } from './query-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Items = { items: string[] };

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

interface Extra {
  loading?: React.ReactNode;
  notFound?: React.ReactNode;
}

function element(query: QueryStateQuery<Items>, extra: Extra) {
  return (
    <QueryState
      query={query}
      errorTitle="Couldn't load items"
      loadingMessage="Loading items…"
      isEmpty={(data) => data.items.length === 0}
      empty={<p>No items yet</p>}
      loading={extra.loading}
      notFound={extra.notFound}
    >
      {(data) => (
        <ul>
          {data.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

function renderState(query: QueryStateQuery<Items>, extra: Extra = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element(query, extra)));
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return {
    container,
    rerender: (next: QueryStateQuery<Items>, nextExtra: Extra = extra) =>
      act(() => root.render(element(next, nextExtra))),
  };
}

function query(overrides: Partial<QueryStateQuery<Items>>): QueryStateQuery<Items> {
  return { data: undefined, error: null, isFetching: false, refetch: vi.fn(), ...overrides };
}

it('shows the loading message while there is no data or error', () => {
  const { container } = renderState(query({ isFetching: true }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading items…');
});

it('uses a loading override such as a skeleton', () => {
  const { container } = renderState(query({}), { loading: <div data-testid="skeleton" /> });
  expect(container.querySelector('[data-testid="skeleton"]')).not.toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('shows the error with a Retry that refetches, never the empty state', () => {
  const refetch = vi.fn();
  const { container } = renderState(query({ error: { message: 'Backend unavailable' }, refetch }));
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Couldn't load items");
  expect(alert?.textContent).toContain('Backend unavailable');
  expect(container.textContent).not.toContain('No items yet');
  act(() => alert?.querySelector('button')?.click());
  expect(refetch).toHaveBeenCalledOnce();
});

it('shows the empty state for loaded empty data', () => {
  const { container } = renderState(query({ data: { items: [] } }));
  expect(container.textContent).toBe('No items yet');
});

it('renders content without a notice when the query succeeded', () => {
  const { container } = renderState(query({ data: { items: ['alpha', 'beta'] } }));
  expect(container.querySelectorAll('li')).toHaveLength(2);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('keeps cached content and adds a Retry notice when a background refetch fails', () => {
  const refetch = vi.fn();
  const items = { items: ['alpha', 'beta'] };
  const { container, rerender } = renderState(query({ data: items }));
  const list = container.querySelector('ul');
  rerender(query({ data: items, error: { message: 'Backend unavailable' }, refetch }));
  // The same list node stays mounted, so scroll position and drafts survive.
  expect(container.querySelector('ul')).toBe(list);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const notice = container.querySelector('[role="status"]');
  expect(notice?.textContent).toContain("Couldn't refresh");
  act(() => notice?.querySelector('button')?.click());
  expect(refetch).toHaveBeenCalledOnce();
});

it('shows notFound for a NOT_FOUND error, even over cached data', () => {
  const error = { message: 'Item not found', data: { code: 'NOT_FOUND' } };
  const { container } = renderState(query({ data: { items: ['alpha'] }, error }), {
    notFound: <p>Item not found</p>,
  });
  expect(container.textContent).toBe('Item not found');
});

it('treats NOT_FOUND as an ordinary error without a notFound branch', () => {
  const error = { message: 'Item not found', data: { code: 'NOT_FOUND' } };
  const { container } = renderState(query({ error }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load items");
});

it('shows the error, not notFound, for other failures', () => {
  const error = { message: 'Database locked', data: { code: 'INTERNAL_SERVER_ERROR' } };
  const { container } = renderState(query({ error }), { notFound: <p>Item not found</p> });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Database locked');
  expect(container.textContent).not.toContain('Item not found');
});
