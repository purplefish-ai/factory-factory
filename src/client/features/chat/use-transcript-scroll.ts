import {
  defaultRangeExtractor,
  elementScroll,
  measureElement,
  useVirtualizer,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  createTranscriptScrollController,
  type TranscriptScrollController,
} from './transcript-scroll-controller';
import { isNativeCompensation, observeTranscriptScroll } from './transcript-scroll-events';
import { createTranscriptPositioner } from './transcript-scroll-position';
import type {
  TranscriptPosition,
  TranscriptScrollOptions,
  TranscriptScrollState,
} from './transcript-scroll.types';

interface Measurement {
  width: number;
  height: number;
}

export function useTranscriptScroll(
  viewport: HTMLDivElement | null,
  keys: string[],
  options: TranscriptScrollOptions
) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<TranscriptScrollController | null>(null);
  const observer = useRef<ReturnType<typeof observeTranscriptScroll> | null>(null);
  // Virtual rows are replaced as they leave the window. Keep their measurements
  // weakly so bookkeeping does not retain detached row DOM for the whole chat.
  const measurements = useRef(new WeakMap<HTMLDivElement, Measurement>());
  const engineRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const committedTotal = useRef(-1);
  const livePosition = useRef<TranscriptPosition | null>(null);
  const [hasContentBelow, setHasContentBelow] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [state, setState] = useState<TranscriptScrollState>({
    intent: options.initialIntent,
    phase: 'suspended',
  });
  const stateRef = useRef(state);
  const enabled =
    options.active &&
    options.ready &&
    !!viewport &&
    viewport.clientWidth > 0 &&
    (dimensions.height > 0 || viewport.clientHeight > 0);

  // Installed before the engine's layout effect registers its scroll listener.
  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (!(viewport && engine)) {
      return;
    }
    const measured = (key: string) => {
      const node = engine.elementsCache.get(key);
      const entry = node && measurements.current.get(node);
      return (
        !!node &&
        !!entry &&
        node.isConnected &&
        entry.width === viewport.clientWidth &&
        Math.abs(entry.height - node.getBoundingClientRect().height) <= 1
      );
    };
    const positioner = createTranscriptPositioner(viewport, engine, measured);
    const current = createTranscriptScrollController({
      initialIntent: latest.current.initialIntent,
      port: {
        cancelPositioning: positioner.cancel,
        scrollToEnd: positioner.scrollToEnd,
        capturePosition: positioner.capture,
        restorePosition: (position) =>
          committedTotal.current === engine.getTotalSize()
            ? positioner.restore(position)
            : { measured: false, reached: false },
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
      },
      onChange: (next) => {
        stateRef.current = next;
        setState((previous) =>
          previous.intent === next.intent && previous.phase === next.phase ? previous : next
        );
      },
      onPositionChange: (position) => {
        livePosition.current = position;
        latest.current.onPositionChange?.(position);
      },
    });
    controller.current = current;
    const events = observeTranscriptScroll(viewport, current);
    observer.current = events;
    let width = viewport.clientWidth;
    let height = viewport.clientHeight;
    const resize = new ResizeObserver(() => {
      const next = { width: viewport.clientWidth, height: viewport.clientHeight };
      if (next.width === width && next.height === height) {
        return;
      }
      width = next.width;
      height = next.height;
      setDimensions(next);
      current.layoutChanged();
      current.measurementReady();
    });
    resize.observe(viewport);
    return () => {
      current.dispose();
      events.dispose();
      resize.disconnect();
      controller.current = null;
      observer.current = null;
      measurements.current = new WeakMap();
    };
  }, [viewport]);

  const engine = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: keys.length,
    getScrollElement: () => viewport,
    getItemKey: (index) => keys[index] ?? `missing-${index}`,
    estimateSize: () => 80,
    overscan: 5,
    paddingStart: 16,
    paddingEnd: 16,
    gap: 8,
    // A banner/image can resize while scrolled out of view. Keep this one
    // leading row measured so its size and native compensation stay current.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      return keys[0] === 'transcript:header' && indexes[0] !== 0 ? [0, ...indexes] : indexes;
    },
    anchorTo: 'start',
    followOnAppend: false,
    // Native compensation can synchronously render more measured rows. Deliver
    // resize batches in the next frame rather than re-entering an RO cycle.
    useAnimationFrameWithResizeObserver: true,
    enabled,
    scrollToFn: (offset, scrollOptions, instance) => {
      const write = () => elementScroll(offset, scrollOptions, instance);
      if (observer.current) {
        observer.current.write(write, isNativeCompensation(scrollOptions));
      } else {
        write();
      }
    },
    measureElement: (node, entry, instance) => {
      const height = measureElement(node, entry, instance);
      const previous = measurements.current.get(node);
      if (height > 0 && node.isConnected && viewport && viewport.clientWidth > 0) {
        const fresh = previous?.width !== viewport.clientWidth || previous.height !== height;
        measurements.current.set(node, { width: viewport.clientWidth, height });
        if (fresh) {
          controller.current?.measurementReady();
        }
      }
      return height;
    },
  });
  engineRef.current = engine;
  engine.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0) + 1;
  const totalSize = engine.getTotalSize();

  useLayoutEffect(() => {
    const current = controller.current;
    if (!(current && viewport)) {
      return;
    }
    if (enabled) {
      current.activate(latest.current.initialPosition);
    } else {
      current.suspend();
    }
    return () => current.suspend();
  }, [enabled, viewport]);

  const previousLayout = useRef<{
    keys: string[];
    size: number;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    committedTotal.current = totalSize;
    const previous = previousLayout.current;
    const width = viewport?.clientWidth ?? 0;
    const height = viewport?.clientHeight ?? 0;
    previousLayout.current = { keys, size: totalSize, width, height };
    if (!enabled) {
      return;
    }
    const changedKeys =
      !previous ||
      previous.keys.length !== keys.length ||
      previous.keys.some((key, index) => keys[index] !== key);
    const appended = previous?.keys.every((key, index) => keys[index] === key);
    if (changedKeys && !appended && livePosition.current && stateRef.current.phase === 'ready') {
      controller.current?.structureChanged(livePosition.current);
    }
    if (
      changedKeys ||
      previous?.size !== totalSize ||
      previous.width !== width ||
      previous.height !== height
    ) {
      controller.current?.layoutChanged();
      controller.current?.measurementReady();
    }
  });
  const updateContentBelow = useCallback(() => {
    setHasContentBelow(
      !!viewport &&
        viewport.clientHeight > 0 &&
        viewport.scrollHeight - viewport.clientHeight - Math.max(0, viewport.scrollTop) > 1
    );
  }, [viewport]);
  // Measure the committed DOM after virtual rows resize, expand, or collapse.
  // Reading intent is independent of geometry and must survive a clamped bottom.
  useLayoutEffect(updateContentBelow);
  useLayoutEffect(() => {
    if (!viewport) {
      return;
    }
    viewport.addEventListener('scroll', updateContentBelow, { passive: true });
    return () => viewport.removeEventListener('scroll', updateContentBelow);
  }, [viewport, updateContentBelow]);
  return {
    engine,
    totalSize,
    state,
    hasContentBelow,
    jumpToLatest: () => controller.current?.jumpToLatest(),
  };
}
