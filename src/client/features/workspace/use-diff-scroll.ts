import { elementScroll, useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { DiffLine } from '@/lib/diff/types';
import { createDiffScrollController } from './diff-scroll-controller';
import type { ScrollState } from './scroll-state';

interface DiffScrollOptions {
  lines: DiffLine[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollState?: ScrollState | null;
  onScrollStateChange?: (state: ScrollState) => void;
}

/** Integrate the virtualizer and DOM with a single scroll lifecycle owner. */
export function useDiffScroll({
  lines,
  scrollContainerRef,
  scrollState,
  onScrollStateChange,
}: DiffScrollOptions) {
  const latest = useRef({ scrollState, onScrollStateChange });
  latest.current = { scrollState, onScrollStateChange };
  const controller = useRef<ReturnType<typeof createDiffScrollController> | null>(null);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const virtualized = lines.length > 200;
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 16,
    overscan: 8,
    enabled: virtualized,
    scrollToFn: (offset, options, instance) => {
      if (controller.current) {
        controller.current.scrollTo(offset + (options.adjustments ?? 0));
      } else {
        elementScroll(offset, options, instance);
      }
    },
  });

  useEffect(() => {
    const viewport = scrollContainerRef.current;
    if (!viewport) {
      return;
    }
    const current = createDiffScrollController({
      viewport,
      virtualizer: virtualized ? virtualizer : undefined,
      invalidateMeasurements: () => {
        if (lines.length > 200) {
          virtualizer.measure();
          // Re-observe mounted rows whose sizes did not change on invalidation.
          setMeasurementVersion((version) => version + 1);
        }
      },
      onPersist: (state) => latest.current.onScrollStateChange?.(state),
    });
    controller.current = current;
    // Radix thumbs are siblings of the viewport, so listen on its root.
    const gestureTarget = viewport.hasAttribute('data-radix-scroll-area-viewport')
      ? (viewport.parentElement ?? viewport)
      : viewport;
    // Observe native user movement before TanStack's scroll listener can
    // measure rows and compensate their heights.
    viewport.addEventListener('scroll', current.persist, { passive: true, capture: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      gestureTarget.addEventListener(event, current.interrupt, { passive: true, capture: true });
    }
    let width = viewport.clientWidth;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (width !== viewport.clientWidth) {
              width = viewport.clientWidth;
              current.resize();
            }
          });
    observer?.observe(viewport);
    current.restore(latest.current.scrollState);
    return () => {
      controller.current = null;
      current.dispose();
      observer?.disconnect();
      viewport.removeEventListener('scroll', current.persist, true);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        gestureTarget.removeEventListener(event, current.interrupt, true);
      }
    };
  }, [lines, virtualized, virtualizer, scrollContainerRef]);
  return { virtualizer, virtualized, measurementVersion };
}
