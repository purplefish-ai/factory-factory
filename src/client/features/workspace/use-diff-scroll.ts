import type { Virtualizer } from '@tanstack/react-virtual';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { DiffLine } from '@/lib/diff/types';
import type { ScrollState } from './scroll-state';

interface DiffScrollOptions {
  lines: DiffLine[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  virtualized: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollState?: ScrollState | null;
  onScrollStateChange?: (state: ScrollState) => void;
}

interface LegacyPositionProgress {
  index: number;
  top: number;
  stalledFrames: number;
}

function measuredRowSize(virtualizer: Virtualizer<HTMLDivElement, Element>, index: number) {
  const key = virtualizer.options.getItemKey(index);
  const element = virtualizer.elementsCache.get(key);
  // TanStack only caches sizes that differ from its estimate. A mounted row
  // with the estimated height still supplies an actual measurement.
  const size =
    virtualizer.itemSizeCache.get(key) ??
    (element?.isConnected
      ? virtualizer.options.measureElement(element, undefined, virtualizer)
      : undefined);
  return size && size > 0 ? size : undefined;
}

// Pixel-only records predate virtualization. Measure a contiguous prefix in
// bounded windows: estimates cannot identify the wrapped row at a saved offset.
function advanceLegacyPosition(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  count: number,
  top: number,
  progress: LegacyPositionProgress
): ScrollState['diffAnchor'] {
  const previousIndex = progress.index;
  while (progress.index < count) {
    const size = measuredRowSize(virtualizer, progress.index);
    if (size === undefined) {
      virtualizer.scrollToIndex(progress.index, { align: 'start' });
      progress.stalledFrames = progress.index === previousIndex ? progress.stalledFrames + 1 : 0;
      return undefined;
    }
    if (progress.top + size > top || progress.index === count - 1) {
      return {
        index: progress.index,
        offset: Math.min(top - progress.top, Math.max(0, size - 1)),
      };
    }
    progress.top += size;
    progress.index += 1;
  }
  return undefined;
}

/** Persist a visible row, since measured wrapping makes absolute offsets unstable. */
export function useDiffScroll({
  lines,
  virtualizer,
  virtualized,
  scrollContainerRef,
  scrollState,
  onScrollStateChange,
}: DiffScrollOptions) {
  const latest = useRef({ scrollState, onScrollStateChange });
  const [measurementVersion, setMeasurementVersion] = useState(0);
  latest.current = { scrollState, onScrollStateChange };

  useEffect(() => {
    const viewport = scrollContainerRef.current;
    if (!viewport) {
      return;
    }
    let frame = 0;
    let restoring = false;
    let pendingState: ScrollState | null | undefined;
    const capture = (): ScrollState => {
      const row = virtualized ? virtualizer.getVirtualItemForOffset(viewport.scrollTop) : undefined;
      return {
        top: viewport.scrollTop,
        left: viewport.scrollLeft,
        ...(row
          ? {
              diffAnchor: { index: row.index, offset: Math.max(0, viewport.scrollTop - row.start) },
            }
          : {}),
      };
    };
    const persist = () => {
      if (!restoring) {
        latest.current.onScrollStateChange?.(capture());
      }
    };
    const restore = (state: ScrollState | null | undefined, invalidate: boolean) => {
      cancelAnimationFrame(frame);
      restoring = true;
      pendingState = state;
      if (invalidate && virtualized) {
        virtualizer.measure();
        // Re-observe mounted rows too: clearing cached sizes does not itself
        // produce ResizeObserver entries for elements whose size stayed fixed.
        setMeasurementVersion((version) => version + 1);
      }
      if (!state) {
        restoring = false;
        return;
      }
      let anchor = virtualized ? state.diffAnchor : undefined;
      const migration = { index: 0, top: 0, stalledFrames: 0 };
      let remaining = 12;
      let stable = 0;
      let previousTop = -1;
      const applyPosition = () => {
        viewport.scrollLeft = state?.left ?? 0;
        if (anchor && lines.length > 0) {
          const index = Math.min(anchor.index, lines.length - 1);
          const row = virtualizer.getVirtualItems().find((item) => item.index === index);
          if (row) {
            virtualizer.scrollToOffset(
              row.start + Math.min(anchor.offset, Math.max(0, row.size - 1))
            );
          } else {
            virtualizer.scrollToIndex(index, { align: 'start' });
          }
        } else {
          viewport.scrollTop = Math.min(
            state?.top ?? 0,
            Math.max(0, viewport.scrollHeight - viewport.clientHeight)
          );
        }
      };
      const align = () => {
        applyPosition();
        stable = Math.abs(viewport.scrollTop - previousTop) < 1 ? stable + 1 : 0;
        previousTop = viewport.scrollTop;
        remaining -= 1;
        if (stable < 3 && remaining > 0) {
          frame = requestAnimationFrame(align);
        } else {
          restoring = false;
          pendingState = null;
          persist();
        }
      };
      const migrate = () => {
        anchor = advanceLegacyPosition(virtualizer, lines.length, state.top, migration);
        if (anchor) {
          frame = requestAnimationFrame(align);
          return;
        }
        // An unmeasurable/hidden viewport must not overwrite the saved state.
        // Gestures still cancel restoration and resume ordinary persistence.
        frame = migration.stalledFrames < 12 ? requestAnimationFrame(migrate) : 0;
      };
      const needsMigration = virtualized && !anchor && state.top > 0;
      frame = requestAnimationFrame(needsMigration ? migrate : align);
    };
    const cancelRestore = () => {
      cancelAnimationFrame(frame);
      restoring = false;
      pendingState = null;
    };
    // Radix scrollbars are siblings of the viewport. Capture gestures on the
    // containing Root so a thumb drag also cancels an in-flight restoration.
    const gestureTarget = viewport.hasAttribute('data-radix-scroll-area-viewport')
      ? (viewport.parentElement ?? viewport)
      : viewport;
    viewport.addEventListener('scroll', persist);
    gestureTarget.addEventListener('wheel', cancelRestore, { passive: true, capture: true });
    gestureTarget.addEventListener('touchstart', cancelRestore, { passive: true, capture: true });
    gestureTarget.addEventListener('pointerdown', cancelRestore, true);
    gestureTarget.addEventListener('keydown', cancelRestore, true);
    let width = viewport.clientWidth;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (width === viewport.clientWidth) {
              return;
            }
            width = viewport.clientWidth;
            restore(pendingState ?? capture(), true);
          });
    observer?.observe(viewport);
    restore(latest.current.scrollState, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport.removeEventListener('scroll', persist);
      gestureTarget.removeEventListener('wheel', cancelRestore, true);
      gestureTarget.removeEventListener('touchstart', cancelRestore, true);
      gestureTarget.removeEventListener('pointerdown', cancelRestore, true);
      gestureTarget.removeEventListener('keydown', cancelRestore, true);
    };
  }, [lines, virtualized, virtualizer, scrollContainerRef]);
  return measurementVersion;
}
