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

function renderState(query: QueryStateQuery<Items>, extra: { loading?: React.ReactNode } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryState
        query={query}
        errorTitle="Couldn't load items"
        loadingMessage="Loading items…"
        isEmpty={(data) => data.items.length === 0}
        empty={<p>No items yet</p>}
        loading={extra.loading}
      >
        {(data) => (
          <ul>
            {data.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </QueryState>
    )
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

function query(overrides: Partial<QueryStateQuery<Items>>): QueryStateQuery<Items> {
  return { data: undefined, error: null, isFetching: false, refetch: vi.fn(), ...overrides };
}

it('shows the loading message while there is no data or error', () => {
  const container = renderState(query({ isFetching: true }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading items…');
});

it('uses a loading override such as a skeleton', () => {
  const container = renderState(query({}), { loading: <div data-testid="skeleton" /> });
  expect(container.querySelector('[data-testid="skeleton"]')).not.toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('shows the error with a Retry that refetches, never the empty state', () => {
  const refetch = vi.fn();
  const container = renderState(query({ error: { message: 'Backend unavailable' }, refetch }));
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Couldn't load items");
  expect(alert?.textContent).toContain('Backend unavailable');
  expect(container.textContent).not.toContain('No items yet');
  act(() => alert?.querySelector('button')?.click());
  expect(refetch).toHaveBeenCalledOnce();
});

it('shows the empty state for loaded empty data', () => {
  const container = renderState(query({ data: { items: [] } }));
  expect(container.textContent).toBe('No items yet');
});

it('renders content, and keeps cached content when a background refetch fails', () => {
  const container = renderState(
    query({ data: { items: ['alpha', 'beta'] }, error: { message: 'Backend unavailable' } })
  );
  expect(container.querySelectorAll('li')).toHaveLength(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
