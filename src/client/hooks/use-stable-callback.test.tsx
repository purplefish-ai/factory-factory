// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStableCallback } from './use-stable-callback';

const seen: Array<(value: number) => number> = [];

function Harness({ offset }: { offset: number }) {
  seen.push(useStableCallback((value: number) => value + offset));
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  seen.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useStableCallback', () => {
  it('keeps one identity across renders and calls the latest callback', () => {
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Harness, { offset: 1 })));
    act(() => root.render(createElement(Harness, { offset: 10 })));

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0]?.(1)).toBe(11);
    act(() => root.unmount());
  });
});
