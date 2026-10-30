// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import {
  captureTranscriptPosition,
  createTranscriptPositioner,
} from './transcript-scroll-position';
import type { TranscriptPosition } from './transcript-scroll.types';

function harness() {
  const viewport = document.createElement('div');
  Object.defineProperties(viewport, {
    scrollHeight: { value: 3000 },
    clientHeight: { value: 500 },
    scrollWidth: { value: 500 },
    clientWidth: { value: 500 },
  });
  const rows = [
    { key: 'a', index: 0, start: 0, end: 100, size: 100, lane: 0 },
    { key: 'b', index: 1, start: 100, end: 1300, size: 1200, lane: 0 },
  ];
  let measured = false;
  const engine = {
    options: { count: 2, gap: 8, getItemKey: (index: number) => rows[index]?.key ?? '' },
    getVirtualItems: () => rows,
    getVirtualItemForOffset: (top: number) =>
      [...rows].reverse().find((row) => row.start <= top) ?? rows[0],
    scrollToIndex: vi.fn(),
    cancelScroll: vi.fn(),
    scrollToOffset: vi.fn((top: number) => {
      viewport.scrollTop = top;
    }),
    scrollToEnd: vi.fn(() => {
      viewport.scrollTop = 2500;
    }),
  };
  const positioner = createTranscriptPositioner(viewport, engine, () => measured);
  const position: TranscriptPosition = {
    intent: 'reading',
    top: 700,
    left: 0,
    anchor: { key: 'b', offset: 37 },
  };
  return {
    viewport,
    engine,
    rows,
    positioner,
    position,
    measure: () => {
      measured = true;
    },
  };
}

it('captures the visible keyed row and offset inside a giant group', () => {
  const h = harness();
  h.viewport.scrollTop = 137;
  expect(captureTranscriptPosition(h.viewport, h.engine, 'reading')).toEqual({
    ...h.position,
    top: 137,
  });
});

it('anchors leading padding with a signed offset without shifting into the first row', () => {
  const h = harness();
  h.rows[0] = { ...h.rows[0]!, start: 16, end: 116 };
  const position = captureTranscriptPosition(h.viewport, h.engine, 'reading');
  expect(position).toEqual({
    intent: 'reading',
    top: 0,
    left: 0,
    anchor: { key: 'a', offset: -16 },
  });
  h.measure();
  h.positioner.restore(position);
  expect(h.viewport.scrollTop).toBe(0);
});
it('anchors the next visible row through gaps, prepends and row wrapping', () => {
  const h = harness();
  h.rows[0] = { ...h.rows[0]!, start: 16, end: 116, size: 100 };
  h.rows[1] = { ...h.rows[1]!, start: 124, end: 224, size: 100 };
  h.viewport.scrollTop = 120;
  const position = captureTranscriptPosition(h.viewport, h.engine, 'reading');
  expect(position.anchor).toEqual({ key: 'b', offset: -4 });
  h.rows[0] = { ...h.rows[0]!, start: 124, end: 224 };
  h.rows[1] = { ...h.rows[1]!, start: 232, end: 632, size: 400 };
  h.measure();
  h.positioner.restore(position);
  expect(h.viewport.scrollTop).toBe(228);
});
it('mounts once, awaits valid measurement, then replaces the index command with row offset', () => {
  const h = harness();
  expect(h.positioner.restore(h.position)).toEqual({ measured: false, reached: false });
  h.positioner.restore(h.position);
  expect(h.engine.scrollToIndex).toHaveBeenCalledOnce();
  h.measure();
  expect(h.positioner.restore(h.position)).toEqual({ measured: true, reached: true });
  expect(h.engine.cancelScroll).toHaveBeenCalled();
  expect(h.viewport.scrollTop).toBe(137);
  h.positioner.restore(h.position);
  expect(h.engine.scrollToOffset).toHaveBeenCalledOnce();
});
it('resolves retained keys after prepend instead of reusing pixel offsets', () => {
  const h = harness();
  h.measure();
  h.rows[1] = { key: 'b', index: 1, start: 500, end: 1700, size: 1200, lane: 0 };
  h.positioner.restore(h.position);
  expect(h.viewport.scrollTop).toBe(537);
});

it('retargets the mounting command when prepends move an unmeasured key', () => {
  const h = harness();
  h.positioner.restore(h.position);
  h.rows.reverse();
  h.positioner.restore(h.position);
  expect(h.engine.scrollToIndex).toHaveBeenLastCalledWith(0, {
    align: 'start',
    behavior: 'instant',
  });
  expect(h.engine.scrollToIndex).toHaveBeenCalledTimes(2);
});
it('uses clamped pixels when the saved key vanished without changing intent', () => {
  const h = harness();
  const missing: TranscriptPosition = {
    intent: 'reading',
    top: 9999,
    left: 0,
    anchor: { key: 'removed', offset: 10 },
  };
  expect(h.positioner.restore(missing)).toEqual({ measured: true, reached: true });
  expect(h.viewport.scrollTop).toBe(2500);
  expect(missing.intent).toBe('reading');
});
it('following requires a measured last row and re-evaluates growing extent', () => {
  const h = harness();
  const following: TranscriptPosition = { intent: 'following', top: 0, left: 0 };
  expect(h.positioner.restore(following)).toEqual({ measured: false, reached: true });
  h.measure();
  expect(h.positioner.restore(following)).toEqual({ measured: true, reached: true });
  h.positioner.cancel();
  expect(h.engine.cancelScroll).toHaveBeenCalled();
});
