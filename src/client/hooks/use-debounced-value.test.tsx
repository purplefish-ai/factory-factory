// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from './use-debounced-value';

const seen: string[] = [];

function Harness({ value, immediate }: { value: string; immediate?: boolean }) {
  seen.push(useDebouncedValue(value, 100, { immediate }));
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  seen.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useDebouncedValue', () => {
  it('adopts the latest value once it has been stable for the delay', () => {
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness, { value: '' })));
    act(() => root.render(createElement(Harness, { value: 'a' })));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    act(() => root.render(createElement(Harness, { value: 'ab' })));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(seen.at(-1)).toBe('');

    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(seen.at(-1)).toBe('ab');
    expect(seen).not.toContain('a');
    act(() => root.unmount());
  });

  it('returns the current value at once while immediate', () => {
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness, { value: 'query' })));
    act(() => root.render(createElement(Harness, { value: '', immediate: true })));
    expect(seen.at(-1)).toBe('');

    act(() => root.render(createElement(Harness, { value: 'next' })));
    expect(seen.at(-1)).toBe('');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(seen.at(-1)).toBe('next');
    act(() => root.unmount());
  });
});
