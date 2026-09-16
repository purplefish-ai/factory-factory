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
let firstRowUnwrapped = false;
let saved: ScrollState | null;
let savedStates: ScrollState[];
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
            savedStates.push(state);
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
  firstRowUnwrapped = false;
  saved = null;
  savedStates = [];
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (firstRowUnwrapped && this.dataset.index === '0') {
      return 16;
    }
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
  const remountedViewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  const remountedRow = container.querySelector<HTMLElement>('[data-index="500"]');
  expect(remountedRow).not.toBeNull();
  expect(
    remountedViewport.scrollTop - Number(remountedRow?.style.transform.match(/[\d.]+/)?.[0])
  ).toBe(7);
});

it.each([
  { top: 31_959, index: 500 },
  { top: 1239, index: 20 },
])('migrates legacy pixel offset $top using measured rows', async ({ top, index }) => {
  firstRowUnwrapped = true;
  await act(() => root.render(<Harness initial={{ top, left: 4 }} />));
  for (let frame = 0; frame < 120; frame++) {
    await act(() => vi.advanceTimersByTime(20));
    expect(container.querySelectorAll('[data-index]').length).toBeLessThan(100);
  }
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  expect(viewport.scrollTop).toBe(top);
  expect(viewport.scrollLeft).toBe(4);
  expect(saved).toMatchObject({ top, diffAnchor: { index, offset: 7 } });
});

it('does not persist migration steps and lets user gestures cancel a legacy restore', async () => {
  await act(() => root.render(<Harness initial={{ top: 32_007, left: 0 }} />));
  await act(() => vi.advanceTimersByTime(20));
  expect(saved).toBeNull();
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

it('does not persist a queued restore scroll after a click cancels refinement', async () => {
  const clicked = interruptFirstWrite('pointerdown');
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await settle();
  expect(clicked()).toBe(true);
  expect(saved).toBeNull();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  await act(() => {
    viewport.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(saved).toBeNull();
  await act(() => {
    viewport.scrollTop = 150;
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(saved?.top).toBe(150);
});

function interruptFirstWrite(
  event: string,
  scrollbar = false,
  queueScroll: (viewport: HTMLElement) => void = (viewport) => {
    setTimeout(() => viewport.dispatchEvent(new Event('scroll')), 0);
  }
) {
  let interrupted = false;
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (
    this: HTMLElement,
    options: ScrollToOptions | number
  ) {
    if (typeof options !== 'object') {
      return;
    }
    this.scrollTop = options.top ?? this.scrollTop;
    this.scrollLeft = options.left ?? this.scrollLeft;
    if (!interrupted && this.scrollTop > 0) {
      interrupted = true;
      setTimeout(() => {
        const target = scrollbar ? container.querySelector('[data-scroll-thumb]')! : this;
        target.dispatchEvent(new Event(event, { bubbles: true }));
      }, 0);
    }
    queueScroll(this);
  });
  return () => interrupted;
}

it.each(['wheel', 'touchstart', 'keydown', 'pointerdown', 'scrollbar'])(
  'hands off to actual scrolling after %s interrupts an offscreen restore',
  async (gesture) => {
    const interrupted = interruptFirstWrite(
      gesture === 'scrollbar' ? 'pointerdown' : gesture,
      gesture === 'scrollbar'
    );
    await act(() =>
      root.render(
        <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
      )
    );
    await settle();
    expect(interrupted()).toBe(true);
    expect(saved).toBeNull();
    const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
    await act(() => {
      viewport.scrollTop = 150;
      viewport.dispatchEvent(new Event('scroll'));
    });
    await settle();
    expect(viewport.scrollTop).toBe(150);
    expect(saved?.top).toBe(150);
  }
);

it('does not swallow real movement when a second click precedes its scroll event', async () => {
  interruptFirstWrite('pointerdown');
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await settle();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  await act(() => {
    viewport.scrollTop = 150;
    viewport.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(saved?.top).toBe(150);
});

it('retains the intended anchor when resizing an interrupted restore', async () => {
  interruptFirstWrite('pointerdown');
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 4, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await settle();
  expect(saved).toBeNull();
  width = 640;
  await act(() => {
    for (const callback of observers) {
      callback([], {} as ResizeObserver);
    }
  });
  await settle();
  expect(saved).toMatchObject({ left: 4, diffAnchor: { index: 500, offset: 7 } });
});

it('does not persist a queued migration scroll after interruption', async () => {
  interruptFirstWrite('pointerdown');
  await act(() => root.render(<Harness initial={{ top: 32_007, left: 4 }} />));
  await settle();
  expect(saved).toBeNull();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  await act(() => {
    viewport.scrollLeft = 40;
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(saved?.left).toBe(40);
});

it('restores the retained anchor when a hidden viewport becomes measurable', async () => {
  width = 0;
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() =>
    width === 0 ? 0 : 320
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (width === 0) {
      return 0;
    }
    return this.hasAttribute('data-index') ? 64 : 320;
  });
  const nativeScroll = HTMLElement.prototype.scrollTo;
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function (
    this: HTMLElement,
    options: ScrollToOptions | number
  ) {
    // Hidden browser elements cannot scroll; do not let jsdom's writable
    // scrollTop accidentally retain the target without the controller's help.
    if (width > 0 && typeof options === 'object') {
      nativeScroll.bind(this)(options);
    }
  });
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 4, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await settle();
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  expect(viewport.scrollTop).toBe(0);
  expect(savedStates).toEqual([]);
  await act(() => {
    width = 320;
    for (const callback of observers) {
      callback([], {} as ResizeObserver);
    }
  });
  await settle();
  expect(saved).toMatchObject({ left: 4, diffAnchor: { index: 500, offset: 7 } });
  for (const state of savedStates) {
    expect(state).toMatchObject({ left: 4, diffAnchor: { index: 500, offset: 7 } });
  }
  const row = container.querySelector<HTMLElement>('[data-index="500"]');
  expect(row).not.toBeNull();
  expect(viewport.scrollTop - Number(row?.style.transform.match(/[\d.]+/)?.[0])).toBe(7);
});

it('cancels pending restoration on unmount without saving an intermediate position', async () => {
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  await act(() => vi.advanceTimersByTime(20));
  await act(() => root.render(null));
  await settle();
  expect(saved).toBeNull();
});

it('uses actual user movement when resize precedes the queued scroll event', async () => {
  const queuedScrolls: (() => void)[] = [];
  const interrupted = interruptFirstWrite('pointerdown', false, (viewport) => {
    queuedScrolls.push(() => viewport.dispatchEvent(new Event('scroll')));
  });
  await act(() =>
    root.render(
      <Harness initial={{ top: 32_007, left: 0, diffAnchor: { index: 500, offset: 7 } }} />
    )
  );
  // Advance just far enough for the first write and interruption, keeping its
  // scroll event pending. A full settle here would erase the ordering under test.
  await act(() => vi.advanceTimersByTime(20));
  expect(interrupted()).toBe(true);
  expect(queuedScrolls.length).toBeGreaterThan(0);
  expect(savedStates).toEqual([]);
  const viewport = container.querySelector<HTMLDivElement>('[data-viewport]')!;
  let userScrollDelivered = false;
  await act(() => {
    viewport.scrollTop = 150;
    queuedScrolls.push(() => {
      userScrollDelivered = true;
      viewport.dispatchEvent(new Event('scroll'));
    });
    width = 640;
    for (const callback of observers) {
      callback([], {} as ResizeObserver);
    }
  });
  expect(userScrollDelivered).toBe(false);
  // At 150px, the old 64px rows put the user 22px into row 2. Resize must
  // commit this movement before delayed events can expose any stale position.
  expect(savedStates).toEqual([{ top: 150, left: 0, diffAnchor: { index: 2, offset: 22 } }]);
  for (let frame = 0; frame < 20; frame++) {
    await act(() => {
      for (const deliver of queuedScrolls.splice(0)) {
        deliver();
      }
      vi.advanceTimersByTime(20);
    });
  }
  expect(userScrollDelivered).toBe(true);
  expect(queuedScrolls).toEqual([]);
  for (const state of savedStates) {
    expect(state.diffAnchor).toEqual({ index: 2, offset: 22 });
  }
  expect(saved).toMatchObject({ top: 86, diffAnchor: { index: 2, offset: 22 } });
});
