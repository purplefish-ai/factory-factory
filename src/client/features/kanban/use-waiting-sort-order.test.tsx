// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useWaitingSortOrder } from './use-waiting-sort-order';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Preference() {
  const [order, setOrder] = useWaitingSortOrder();
  return createElement(
    'button',
    {
      onClick: () => setOrder(order === 'created' ? 'latest-message' : 'created'),
    },
    order
  );
}

function mountPreference() {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(Preference)));
  return { container, unmount: () => act(() => root.unmount()) };
}

it('persists both choices across remounts', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const first = mountPreference();
  expect(first.container.textContent).toBe('latest-message');
  act(() => first.container.querySelector('button')!.click());
  expect(localStorage.getItem('kanban-waiting-sort-order')).toBe('created');
  first.unmount();

  const second = mountPreference();
  expect(second.container.textContent).toBe('created');
  act(() => second.container.querySelector('button')!.click());
  second.unmount();
  const third = mountPreference();
  expect(third.container.textContent).toBe('latest-message');
  third.unmount();
});

it('ignores invalid stored values and tolerates unavailable storage', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem('kanban-waiting-sort-order', 'oldest-waiting');
  const invalid = mountPreference();
  expect(invalid.container.textContent).toBe('latest-message');
  invalid.unmount();

  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  const blocked = mountPreference();
  expect(blocked.container.textContent).toBe('latest-message');
  act(() => blocked.container.querySelector('button')!.click());
  expect(blocked.container.textContent).toBe('created');
  blocked.unmount();
});
