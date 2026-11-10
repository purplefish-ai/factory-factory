// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePlanViewMode } from './plan-view-preference';

const KEY = 'ff:plan-view-mode';

function Toggle() {
  const [mode, setMode] = usePlanViewMode();
  return (
    <button type="button" onClick={() => setMode(mode === 'raw' ? 'rendered' : 'raw')}>
      {mode}
    </button>
  );
}

function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<Toggle />));
  return {
    button: () => host.querySelector('button'),
    unmount: () => flushSync(() => root.unmount()),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('defaults to rendered and falls back from invalid values', () => {
  const empty = mount();
  expect(empty.button()?.textContent).toBe('rendered');
  empty.unmount();
  localStorage.setItem(KEY, 'invalid');
  const invalid = mount();
  expect(invalid.button()?.textContent).toBe('rendered');
  invalid.unmount();
});

it('restores and stores the raw string preference without writing on mount', () => {
  localStorage.setItem(KEY, 'raw');
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const view = mount();
  expect(view.button()?.textContent).toBe('raw');
  expect(setItem).not.toHaveBeenCalled();
  flushSync(() => view.button()?.click());
  expect(view.button()?.textContent).toBe('rendered');
  expect(localStorage.getItem(KEY)).toBe('rendered');
  view.unmount();
});
