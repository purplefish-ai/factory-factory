import type { Virtualizer } from '@tanstack/react-virtual';
import type { ScrollState } from './scroll-state';

export type DiffVirtualizer = Virtualizer<HTMLDivElement, Element>;
export interface LegacyPositionProgress {
  index: number;
  top: number;
  stalledFrames: number;
}

function measuredRowSize(virtualizer: DiffVirtualizer, index: number) {
  const key = virtualizer.options.getItemKey(index);
  const element = virtualizer.elementsCache.get(key);
  // Rows at the estimated height are absent from itemSizeCache.
  const size =
    virtualizer.itemSizeCache.get(key) ??
    (element?.isConnected
      ? virtualizer.options.measureElement(element, undefined, virtualizer)
      : undefined);
  return size && size > 0 ? size : undefined;
}

// Our restore does not enable TanStack's programmatic scroll state. During
// scrolling, ref callbacks defer measurements to ResizeObserver; sample mounted
// rows in our frame too so alignment and legacy migration use committed sizes.
export function measureDiffRows(virtualizer: DiffVirtualizer) {
  for (const element of Array.from(virtualizer.elementsCache.values())) {
    if (element.isConnected) {
      const size = virtualizer.options.measureElement(element, undefined, virtualizer);
      if (size > 0) {
        virtualizer.resizeItem(virtualizer.indexFromElement(element), size);
      }
    }
  }
}

export function captureDiffScroll(
  viewport: HTMLDivElement,
  virtualizer?: DiffVirtualizer
): ScrollState {
  const row = virtualizer?.getVirtualItemForOffset(viewport.scrollTop);
  return {
    top: viewport.scrollTop,
    left: viewport.scrollLeft,
    ...(row
      ? { diffAnchor: { index: row.index, offset: Math.max(0, viewport.scrollTop - row.start) } }
      : {}),
  };
}

// Coordinates only: neither positioning nor migration starts a virtualizer retry loop.
function anchorPosition(
  virtualizer: DiffVirtualizer,
  anchor: NonNullable<ScrollState['diffAnchor']>
) {
  const index = Math.min(anchor.index, virtualizer.options.count - 1);
  const row = virtualizer.getVirtualItems().find((item) => item.index === index);
  const measured = row && measuredRowSize(virtualizer, index) !== undefined;
  return {
    top: row
      ? row.start + Math.min(anchor.offset, Math.max(0, row.size - 1))
      : (virtualizer.getOffsetForIndex(index, 'start')?.[0] ?? 0),
    measured: Boolean(measured),
  };
}

export function restorePosition(
  virtualizer: DiffVirtualizer | undefined,
  top: number,
  anchor: ScrollState['diffAnchor']
) {
  if (virtualizer) {
    measureDiffRows(virtualizer);
    if (anchor) {
      return anchorPosition(virtualizer, anchor);
    }
  }
  return { top, measured: true };
}

// Pixel-only records need a contiguous measured prefix, traversed in bounded windows.
export function advanceLegacyPosition(
  virtualizer: DiffVirtualizer,
  top: number,
  progress: LegacyPositionProgress
): { anchor?: ScrollState['diffAnchor']; top?: number } {
  const previousIndex = progress.index;
  while (progress.index < virtualizer.options.count) {
    const size = measuredRowSize(virtualizer, progress.index);
    if (size === undefined) {
      progress.stalledFrames = progress.index === previousIndex ? progress.stalledFrames + 1 : 0;
      return { top: virtualizer.getOffsetForIndex(progress.index, 'start')?.[0] };
    }
    if (progress.top + size > top || progress.index === virtualizer.options.count - 1) {
      return {
        anchor: {
          index: progress.index,
          offset: Math.min(top - progress.top, Math.max(0, size - 1)),
        },
      };
    }
    progress.top += size;
    progress.index += 1;
  }
  return {};
}
