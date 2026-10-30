import type { VirtualItem } from '@tanstack/react-virtual';
import type { TranscriptIntent, TranscriptPosition } from './transcript-scroll.types';

interface PositionEngine {
  options: { count: number; getItemKey: (index: number) => string | number | bigint };
  getVirtualItems(): VirtualItem[];
  getVirtualItemForOffset(offset: number): VirtualItem | undefined;
  scrollToIndex(index: number, options: { align: 'start'; behavior: 'instant' }): void;
  scrollToOffset(top: number, options: { behavior: 'instant' }): void;
  scrollToEnd(options: { behavior: 'instant' }): void;
  cancelScroll(): void;
}

export function captureTranscriptPosition(
  viewport: HTMLDivElement,
  engine: PositionEngine,
  intent: TranscriptIntent
): TranscriptPosition {
  const top = Math.max(0, viewport.scrollTop);
  const row = engine.getVirtualItemForOffset(top);
  return {
    intent,
    top,
    left: Math.max(0, viewport.scrollLeft),
    ...(row ? { anchor: { key: String(row.key), offset: Math.max(0, top - row.start) } } : {}),
  };
}

/** Stages native commands, rather than repeatedly replacing index/offset targets. */
export function createTranscriptPositioner(
  viewport: HTMLDivElement,
  engine: PositionEngine,
  isMeasured: (key: string) => boolean
) {
  let target: TranscriptPosition | null = null;
  let mounting: number | null = null;
  let written: number | null = null;
  const cancel = () => {
    engine.cancelScroll();
    target = null;
    mounting = null;
    written = null;
  };
  const scrollToEnd = () => {
    if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1) {
      engine.scrollToEnd({ behavior: 'instant' });
    }
  };
  const readingTop = (position: TranscriptPosition) => {
    let top = position.top;
    const anchor = position.anchor;
    const index = anchor
      ? Array.from({ length: engine.options.count }, (_, i) => i).find(
          (i) => String(engine.options.getItemKey(i)) === anchor.key
        )
      : undefined;
    if (anchor && index !== undefined) {
      const row = engine.getVirtualItems().find((item) => item.index === index);
      if (!(row && isMeasured(anchor.key))) {
        if (mounting !== index) {
          engine.cancelScroll();
          engine.scrollToIndex(index, { align: 'start', behavior: 'instant' });
          mounting = index;
        }
        return null;
      }
      top = row.start + Math.min(Math.max(0, anchor.offset), Math.max(0, row.size - 1));
    }
    return top;
  };
  const restore = (position: TranscriptPosition) => {
    if (target !== position) {
      cancel();
      target = position;
    }
    if (position.intent === 'following') {
      scrollToEnd();
      const key =
        engine.options.count > 0 ? engine.options.getItemKey(engine.options.count - 1) : null;
      return {
        measured: key === null || isMeasured(String(key)),
        reached: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1,
      };
    }
    let top = readingTop(position);
    if (top === null) {
      return { measured: false, reached: false };
    }
    top = Math.min(Math.max(0, top), Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    if (written === null || Math.abs(written - top) > 1) {
      engine.cancelScroll();
      engine.scrollToOffset(top, { behavior: 'instant' });
      viewport.scrollLeft = Math.min(
        Math.max(0, position.left),
        Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      );
      written = top;
    }
    return { measured: true, reached: Math.abs(viewport.scrollTop - top) <= 1 };
  };
  return {
    restore,
    cancel,
    scrollToEnd,
    capture: (intent: TranscriptIntent) => captureTranscriptPosition(viewport, engine, intent),
  };
}
