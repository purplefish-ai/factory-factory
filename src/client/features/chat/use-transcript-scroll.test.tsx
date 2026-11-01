// @vitest-environment jsdom
import { type Virtualizer, type VirtualizerOptions } from '@tanstack/react-virtual';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTranscriptPositioner } from './transcript-scroll-position';
import { useTranscriptScroll } from './use-transcript-scroll';

// Keep the real engine's options and element cache, without mounting its own
// observers: these tests drive row measurements explicitly.
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    useVirtualizer: (options: VirtualizerOptions<HTMLDivElement, HTMLDivElement>) => {
      const engine = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
      engine.current ??= new actual.Virtualizer(options);
      engine.current.setOptions(options);
      return engine.current;
    },
  };
});
vi.mock('./transcript-scroll-position', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transcript-scroll-position')>();
  return { ...actual, createTranscriptPositioner: vi.fn(actual.createTranscriptPositioner) };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

let root: Root;
let container: HTMLDivElement;
let viewport: HTMLDivElement;
let engine: Virtualizer<HTMLDivElement, HTMLDivElement>;
let width: number;
let hasContentBelow: boolean;

function Probe() {
  ({ engine, hasContentBelow } = useTranscriptScroll(viewport, ['row'], {
    identity: 'test',
    active: false,
    ready: true,
    initialIntent: 'reading',
    initialPosition: null,
  }));
  return null;
}

function row(height = 100) {
  const node = document.createElement('div');
  node.dataset.index = '0';
  Object.defineProperty(node, 'offsetHeight', { configurable: true, value: height });
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, height));
  viewport.appendChild(node);
  return node;
}

function measure(node: HTMLDivElement) {
  engine.options.measureElement(node, undefined, engine);
}

function measured() {
  const calls = vi.mocked(createTranscriptPositioner).mock.calls;
  const call = calls.at(-1);
  if (!call) {
    throw new Error('Expected a transcript positioner');
  }
  return call[2]('row');
}

beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    }
  );
  width = 500;
  container = document.createElement('div');
  viewport = document.createElement('div');
  Object.defineProperty(viewport, 'clientWidth', { get: () => width });
  document.body.append(container, viewport);
  root = createRoot(container);
  await act(() => root.render(<Probe />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  viewport.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('requires a connected measurement for the current cached row node', () => {
  const node = row();
  expect(measured()).toBe(false);
  engine.elementsCache.set('row', node);
  expect(measured()).toBe(false);
  measure(node);
  expect(measured()).toBe(true);
  node.remove();
  expect(measured()).toBe(false);
});

it('does not let a late old-node measurement invalidate the replacement row', () => {
  const old = row();
  engine.elementsCache.set('row', old);
  measure(old);
  const replacement = row(200);
  engine.elementsCache.set('row', replacement);
  expect(measured()).toBe(false);
  measure(replacement);
  expect(measured()).toBe(true);
  measure(old);
  expect(measured()).toBe(true);
  old.remove();
  expect(measured()).toBe(true);
});

it('requires a new measurement after viewport width changes', () => {
  const node = row();
  engine.elementsCache.set('row', node);
  measure(node);
  expect(measured()).toBe(true);
  width = 300;
  expect(measured()).toBe(false);
  measure(node);
  expect(measured()).toBe(true);
});

it('waits for remeasurement when a mounted row changes height', () => {
  const node = row();
  engine.elementsCache.set('row', node);
  measure(node);
  vi.mocked(node.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, width, 200));
  expect(measured()).toBe(false);
  Object.defineProperty(node, 'offsetHeight', { value: 200 });
  measure(node);
  expect(measured()).toBe(true);
});

it('tracks content below the viewport through scrolling and layout changes', async () => {
  let height = 200;
  let contentHeight = 200;
  Object.defineProperty(viewport, 'clientHeight', { get: () => height });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => contentHeight });
  await act(() => root.render(<Probe />));
  expect(hasContentBelow).toBe(false);

  contentHeight = 600;
  await act(() => root.render(<Probe />));
  expect(hasContentBelow).toBe(true);

  viewport.scrollTop = 400;
  await act(() => viewport.dispatchEvent(new Event('scroll')));
  expect(hasContentBelow).toBe(false);

  viewport.scrollTop = 100;
  await act(() => viewport.dispatchEvent(new Event('scroll')));
  expect(hasContentBelow).toBe(true);

  height = 600;
  await act(() => root.render(<Probe />));
  expect(hasContentBelow).toBe(false);

  height = 200;
  viewport.scrollTop = 0;
  await act(() => root.render(<Probe />));
  expect(hasContentBelow).toBe(true);
  contentHeight = 200;
  await act(() => root.render(<Probe />));
  expect(hasContentBelow).toBe(false);
});
