import {
  advanceLegacyPosition,
  captureDiffScroll,
  type DiffVirtualizer,
  measureDiffRows,
  restorePosition,
} from './diff-scroll-position';
import type { ScrollState } from './scroll-state';

interface Options {
  viewport: HTMLDivElement;
  virtualizer?: DiffVirtualizer;
  invalidateMeasurements: () => void;
  onPersist: (state: ScrollState) => void;
}

function reachedPosition(viewport: HTMLDivElement, top: number, previousTop: number) {
  return (
    viewport.clientHeight > 0 &&
    viewport.clientWidth > 0 &&
    Math.abs(viewport.scrollTop - top) < 1 &&
    Math.abs(viewport.scrollTop - previousTop) < 1
  );
}

/** One owner for restore frames, user takeover, and permission to persist. */
export function createDiffScrollController({
  viewport,
  virtualizer,
  invalidateMeasurements,
  onPersist,
}: Options) {
  let frame = 0;
  let pending: { status: 'restoring' | 'interrupted'; target: ScrollState } | null = null;
  let observedPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
  const capture = () => captureDiffScroll(viewport, virtualizer);
  const matchesObservedPosition = () =>
    observedPosition.top === viewport.scrollTop && observedPosition.left === viewport.scrollLeft;
  const commit = () => {
    pending = null;
    onPersist(capture());
  };
  const persist = () => {
    if (pending?.status === 'restoring' || matchesObservedPosition()) {
      return;
    }
    observedPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
    commit();
  };
  const scrollTo = (top: number, left = viewport.scrollLeft) => {
    if (pending?.status !== 'restoring' && !matchesObservedPosition()) {
      // A native user scroll has happened but its event has not arrived yet.
      // Reject corrections based on the old offset until persist observes it.
      // Leave observedPosition intact so every correction in this batch yields.
      commit();
      return;
    }
    // All programmatic writes, including TanStack measurement compensation,
    // remain identifiable after cancellation and delayed scroll delivery.
    viewport.scrollTo({ top, left, behavior: 'instant' });
    observedPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
  };
  const interrupt = () => {
    cancelAnimationFrame(frame);
    if (pending?.status === 'restoring') {
      pending.status = 'interrupted';
      observedPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
    }
  };
  const restore = (state: ScrollState | null | undefined) => {
    cancelAnimationFrame(frame);
    pending = state ? { status: 'restoring', target: state } : null;
    invalidateMeasurements();
    if (!state) {
      return;
    }
    let anchor = virtualizer ? state.diffAnchor : undefined;
    const migration = { index: 0, top: 0, stalledFrames: 0 };
    let remaining = 12;
    let stable = 0;
    let previousTop = -1;
    const align = () => {
      const position = restorePosition(virtualizer, state.top, anchor);
      const top = Math.max(
        0,
        Math.min(position.top, viewport.scrollHeight - viewport.clientHeight)
      );
      scrollTo(top, state.left);
      stable = position.measured && reachedPosition(viewport, top, previousTop) ? stable + 1 : 0;
      previousTop = viewport.scrollTop;
      remaining -= 1;
      if (stable >= 3) {
        commit();
      } else if (remaining > 0) {
        frame = requestAnimationFrame(align);
      } else {
        // A retry budget is not proof of a completed restore.
        interrupt();
      }
    };
    const migrate = () => {
      if (!virtualizer) {
        return;
      }
      measureDiffRows(virtualizer);
      const next = advanceLegacyPosition(virtualizer, state.top, migration);
      anchor = next.anchor;
      if (anchor) {
        frame = requestAnimationFrame(align);
      } else if (migration.stalledFrames < 12) {
        if (next.top !== undefined) {
          scrollTo(next.top, state.left);
        }
        frame = requestAnimationFrame(migrate);
      } else {
        interrupt();
      }
    };
    frame = requestAnimationFrame(virtualizer && !anchor && state.top > 0 ? migrate : align);
  };
  return {
    restore,
    interrupt,
    persist,
    scrollTo,
    resize: () => {
      // Native movement may precede its queued scroll event. Preserve that
      // takeover before deciding whether an interrupted target is still valid.
      if (pending?.status === 'interrupted') {
        persist();
      }
      restore(pending?.target ?? capture());
    },
    dispose: () => cancelAnimationFrame(frame),
  };
}
