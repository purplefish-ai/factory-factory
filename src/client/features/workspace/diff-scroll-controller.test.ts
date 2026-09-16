// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDiffScrollController } from './diff-scroll-controller';
import type { ScrollState } from './scroll-state';

let viewport: HTMLDivElement;
let saved: ScrollState[];
let controller: ReturnType<typeof createDiffScrollController>;

beforeEach(() => {
  vi.useFakeTimers();
  viewport = document.createElement('div');
  Object.defineProperties(viewport, {
    clientHeight: { value: 320 },
    clientWidth: { value: 320 },
    scrollHeight: { value: 2000 },
  });
  viewport.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === 'object') {
      viewport.scrollTop = options.top ?? viewport.scrollTop;
      viewport.scrollLeft = options.left ?? viewport.scrollLeft;
    }
  };
  saved = [];
  controller = createDiffScrollController({
    viewport,
    invalidateMeasurements: () => {
      /* This fixture uses non-virtualized pixel positions. */
    },
    onPersist: (state) => saved.push(state),
  });
});

afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
});

it('preserves user takeover before delayed measurement compensation and its scroll event', () => {
  controller.restore({ top: 1000, left: 0 });
  vi.advanceTimersByTime(20);
  controller.interrupt();
  viewport.scrollTop = 150;
  // Both corrections were based on the previous virtualizer offset. Neither
  // may move the viewport or conceal this native user movement from storage.
  controller.scrollTo(1032);
  controller.scrollTo(1064);
  controller.persist();
  expect(viewport.scrollTop).toBe(150);
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.every((state) => state.top === 150)).toBe(true);
});

it('does not save measurement compensation after an interruption without movement', () => {
  controller.restore({ top: 1000, left: 0 });
  vi.advanceTimersByTime(20);
  controller.interrupt();
  controller.scrollTo(1032);
  controller.persist();
  controller.scrollTo(1064);
  controller.persist();
  expect(saved).toEqual([]);
});
