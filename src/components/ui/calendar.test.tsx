// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Calendar } from './calendar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

function dayButton(day: number): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `button[data-day="${new Date(2026, 8, day).toLocaleDateString()}"]`
  );
  if (!button) {
    throw new Error(`Missing day ${day}`);
  }
  return button;
}

it('selects an enabled date while preserving disabled dates and selected styling', async () => {
  const onSelect = vi.fn();
  await act(() =>
    root.render(
      <Calendar
        mode="single"
        defaultMonth={new Date(2026, 8)}
        selected={new Date(2026, 8, 9)}
        onSelect={onSelect}
        disabled={new Date(2026, 8, 10)}
      />
    )
  );
  expect(dayButton(9).getAttribute('data-selected-single')).toBe('true');
  expect(dayButton(10).disabled).toBe(true);
  await act(() => dayButton(10).click());
  expect(onSelect).not.toHaveBeenCalled();
  await act(() => dayButton(11).click());
  expect(onSelect.mock.calls[0]?.[0]).toEqual(new Date(2026, 8, 11));
});

it('navigates months with the next-month control', async () => {
  await act(() => root.render(<Calendar defaultMonth={new Date(2026, 8)} />));
  const next = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Go to the Next Month"]'
  );
  if (!next) {
    throw new Error('Missing next-month control');
  }
  await act(() => next.click());
  expect(container.textContent).toContain('October 2026');
});

it('changes month and year through dropdown captions', async () => {
  await act(() =>
    root.render(
      <Calendar
        defaultMonth={new Date(2026, 8)}
        captionLayout="dropdown"
        startMonth={new Date(2025, 0)}
        endMonth={new Date(2027, 11)}
      />
    )
  );
  const month = container.querySelector<HTMLSelectElement>('select[aria-label="Choose the Month"]');
  const year = container.querySelector<HTMLSelectElement>('select[aria-label="Choose the Year"]');
  if (!(month && year)) {
    throw new Error('Missing month/year dropdowns');
  }
  await act(() => {
    month.value = '9';
    month.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(() => {
    year.value = '2027';
    year.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('table')?.getAttribute('aria-label')).toBe('October 2027');
});
