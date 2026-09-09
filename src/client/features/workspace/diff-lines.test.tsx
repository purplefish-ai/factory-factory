// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DiffLine } from '@/lib/diff/types';
import { DiffLines } from './diff-lines';
import type { ScrollState } from './scroll-state';

const lines: DiffLine[] = Array.from({ length: 1000 }, (_, index) => ({
  type: 'addition',
  content: `wrapped row ${index}`,
  lineNumber: { new: index + 1 },
}));
let container: HTMLDivElement;
let root: Root;
let width = 320;
let saved: ScrollState | null;
const observers = new Set<ResizeObserverCallback>();

function Harness({ initial, count = 1000 }: { initial?: ScrollState | null; count?: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div
        ref={viewport}
        data-viewport=""
        data-radix-scroll-area-viewport=""
        style={{ height: 320, overflow: 'auto' }}
      >
        <DiffLines
          lines={count === 1000 ? lines : lines.slice(0, count)}
          lineNumberWidth={3}
          tokenMap={null}
          scrollContainerRef={viewport}
          scrollState={initial}
          onScrollStateChange={(state) => {
            saved = state;
          }}
        />
      </div>
      <button type="button" data-scroll-thumb="">
        Drag scrollbar
      </button>
    </div>
  );
}

beforeEach(() => {
  width = 320;
  saved = null;
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-index') ? (width === 320 ? 64 : 32) : 320;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Number.parseFloat((this.firstElementChild as HTMLElement)?.style.height ?? '') || 64_000;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.add(callback);
      }
      observe() {
        /* Sizes are supplied by the element metrics. */
      }
      unobserve() {
        /* No native observation is active. */
      }
      disconnect() {
        /* No native observation is active. */
      }
    }
  );
  HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === 'object') {
      this.scrollTop = options.top ?? this.scrollTop;
      this.scrollLeft = options.left ?? this.scrollLeft;
      setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
    }
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle() {
  for (let frame = 0; frame < 20; frame++) {
    await act(() => vi.advanceTimersByTime(20));
  }
}

it('restores the same wrapped row and intra-row offset after remount', async () => {
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await settle();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  const row = container.querySelector<HTMLElement>('[data-index="500"]');
  expect(row).not.toBeNull();
  const start = Number(row?.style.transform.match(/[\d.]+/)?.[0]);
  expect(viewport.scrollTop - start).toBe(7);
  await act(() => viewport.dispatchEvent(new Event('scroll')));
  expect(saved).toMatchObject({ diffAnchor: { index: 500, offset: 7 } });
  const persisted = saved;
  await act(() => root.render(null));
  await act(() => root.render(<Harness initial={persisted} />));
  await settle();
  expect(container.querySelector('[data-index="500"]')).not.toBeNull();
});

it('restores legacy pixel offsets for small diffs', async () => {
  await act(() => root.render(<Harness count={10} initial={{ top: 140, left: 4 }} />));
  await settle();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  expect(viewport.scrollTop).toBe(140);
  expect(viewport.scrollLeft).toBe(4);
});

it('preserves the visible anchor when width invalidates wrapped row measurements', async () => {
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await settle();
  width = 640;
  await act(() => {
    for (const callback of observers) {
      callback([], {} as ResizeObserver);
    }
  });
  await settle();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  const row = container.querySelector<HTMLElement>('[data-index="500"]');
  expect(row).not.toBeNull();
  expect(viewport.scrollTop - Number(row?.style.transform.match(/[\d.]+/)?.[0])).toBe(7);
  const nextRow = container.querySelector<HTMLElement>('[data-index="501"]');
  expect(
    Number(nextRow?.style.transform.match(/[\d.]+/)?.[0]) -
      Number(row?.style.transform.match(/[\d.]+/)?.[0])
  ).toBe(32);
});

it('keeps mounted wrapped rows measured at the top while resizing', async () => {
  await act(() => root.render(<Harness />));
  await settle();
  const second = () => container.querySelector<HTMLElement>('[data-index="1"]');
  expect(second()?.style.transform).toBe('translateY(64px)');
  width = 640;
  await act(() => {
    for (const callback of observers) {
      callback([], {} as ResizeObserver);
    }
  });
  await settle();
  expect(second()?.style.transform).toBe('translateY(32px)');
});

it('lets user scrolling interrupt a pending anchor restoration', async () => {
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  await act(() => {
    viewport.dispatchEvent(new Event('wheel'));
    viewport.scrollTop = 150;
    viewport.dispatchEvent(new Event('scroll'));
  });
  await settle();
  expect(viewport.scrollTop).toBe(150);
  expect(saved?.top).toBe(150);
});

it('lets a sibling Radix scrollbar interrupt pending restoration', async () => {
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  const currentViewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  await act(() => {
    container
      .querySelector('[data-scroll-thumb]')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    currentViewport.scrollTop = 150;
    currentViewport.dispatchEvent(new Event('scroll'));
  });
  await settle();
  expect(currentViewport.scrollTop).toBe(150);
  expect(saved?.top).toBe(150);
});
