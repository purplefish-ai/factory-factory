// @vitest-environment jsdom

import { type ComponentProps, createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import { VirtualizedMessageList } from './virtualized-message-list';

const virtualizerMocks = vi.hoisted(() => ({
  getVirtualItems: vi.fn(() => []),
  getTotalSize: vi.fn(() => 0),
  measureElement: vi.fn(),
  scrollToIndex: vi.fn(),
}));

const resizeObserverMocks = vi.hoisted(() => ({
  callbacks: new Set<ResizeObserverCallback>(),
}));

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverMocks.callbacks.add(callback);
  }

  observe() {
    // No-op for tests.
  }

  disconnect() {
    resizeObserverMocks.callbacks.delete(this.callback);
  }

  unobserve() {
    // No-op for tests.
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => ({
    getVirtualItems: virtualizerMocks.getVirtualItems,
    getTotalSize: virtualizerMocks.getTotalSize,
    measureElement: virtualizerMocks.measureElement,
    scrollToIndex: virtualizerMocks.scrollToIndex,
  })),
}));

vi.mock('@/components/agent-activity', () => ({
  GroupedMessageItemRenderer: () => null,
  LoadingIndicator: () => null,
}));

vi.mock('@/components/agent-activity/message-renderers', () => ({
  ThinkingCompletionProvider: ({ children }: { children: ReactNode }) => children,
}));

interface RenderHarness {
  render: (overrides: Partial<ComponentProps<typeof VirtualizedMessageList>>) => void;
  viewport: HTMLDivElement;
  cleanup: () => void;
}

function makeMessage(id: string, order: number): GroupedMessageItem {
  return {
    id,
    source: 'user',
    text: `message-${order}`,
    timestamp: '2026-02-15T00:00:00.000Z',
    order,
  };
}

function createHarness(
  initialProps: Partial<ComponentProps<typeof VirtualizedMessageList>>
): RenderHarness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const viewport = document.createElement('div');
  container.appendChild(viewport);
  const root = createRoot(container);

  const baseProps: ComponentProps<typeof VirtualizedMessageList> = {
    messages: [],
    running: false,
    startingSession: false,
    loadingSession: false,
    scrollContainerRef: { current: viewport },
  };

  const render = (overrides: Partial<ComponentProps<typeof VirtualizedMessageList>>) => {
    flushSync(() => {
      root.render(createElement(VirtualizedMessageList, { ...baseProps, ...overrides }));
    });
  };

  render(initialProps);

  return {
    render,
    viewport,
    cleanup: () => {
      root.unmount();
      container.remove();
    },
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function triggerResize(height: number) {
  const entry = {
    contentRect: {
      width: 0,
      height,
      x: 0,
      y: 0,
      top: 0,
      right: 0,
      bottom: height,
      left: 0,
      toJSON: () => ({}),
    },
  } as unknown as ResizeObserverEntry;

  for (const callback of resizeObserverMocks.callbacks) {
    callback([entry], {} as ResizeObserver);
  }
}

afterEach(() => {
  virtualizerMocks.getVirtualItems.mockClear();
  virtualizerMocks.getTotalSize.mockClear();
  virtualizerMocks.measureElement.mockClear();
  virtualizerMocks.scrollToIndex.mockClear();
  resizeObserverMocks.callbacks.clear();
  document.body.innerHTML = '';
});

describe('VirtualizedMessageList auto-scroll behavior', () => {
  it('does not auto-scroll while session hydration is loading', async () => {
    const harness = createHarness({
      loadingSession: true,
      messages: [],
    });

    harness.render({
      loadingSession: true,
      messages: [makeMessage('m-1', 0)],
    });
    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
    });

    await flushEffects();

    expect(virtualizerMocks.scrollToIndex).not.toHaveBeenCalled();

    harness.cleanup();
  });

  it('auto-scrolls when new messages are appended outside hydration', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [],
    });

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
    });

    await flushEffects();

    expect(virtualizerMocks.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtualizerMocks.scrollToIndex).toHaveBeenCalledWith(0, {
      align: 'end',
      behavior: 'auto',
    });

    harness.cleanup();
  });

  it('keeps append pin scheduled even if isNearBottom prop flips before RAF', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [],
      isNearBottom: true,
    });

    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      value: 640,
    });
    harness.viewport.scrollTop = 120;

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: true,
    });

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: false,
    });

    await flushAnimationFrame();

    expect(harness.viewport.scrollTop).toBe(640);

    harness.cleanup();
  });

  it('cancels pending append pin RAF when session transitions to loading', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [],
      isNearBottom: true,
    });

    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      value: 640,
    });
    harness.viewport.scrollTop = 120;

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: true,
    });

    harness.render({
      loadingSession: true,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: true,
    });

    await flushAnimationFrame();

    expect(harness.viewport.scrollTop).toBe(120);

    harness.cleanup();
  });

  it('auto-scrolls to bottom when latestThinking grows and user is near bottom', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      latestThinking: 'thinking 1',
      isNearBottom: true,
    });

    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      value: 480,
    });
    harness.viewport.scrollTop = 120;

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      latestThinking: 'thinking 1 more',
      isNearBottom: true,
    });

    await flushEffects();

    expect(harness.viewport.scrollTop).toBe(480);

    harness.cleanup();
  });

  it('does not auto-scroll latestThinking updates when user is away from bottom', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      latestThinking: 'thinking 1',
      isNearBottom: false,
    });

    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      value: 480,
    });
    harness.viewport.scrollTop = 120;

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      latestThinking: 'thinking 1 more',
      isNearBottom: false,
    });

    await flushEffects();

    expect(harness.viewport.scrollTop).toBe(120);

    harness.cleanup();
  });

  it('attaches growth pinning after transitioning from empty state to messages', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [],
      isNearBottom: true,
    });

    let scrollHeight = 640;
    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(harness.viewport, 'clientHeight', {
      configurable: true,
      value: 560,
    });
    harness.viewport.scrollTop = 80;

    await flushEffects();

    harness.render({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: true,
    });
    await flushEffects();
    await flushAnimationFrame();

    scrollHeight = 920;
    triggerResize(220);
    await flushAnimationFrame();

    expect(harness.viewport.scrollTop).toBe(920);

    harness.cleanup();
  });

  it('keeps viewport pinned when content grows and user is near bottom', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: true,
    });

    let scrollHeight = 640;
    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(harness.viewport, 'clientHeight', {
      configurable: true,
      value: 500,
    });
    harness.viewport.scrollTop = 120;

    await flushEffects();

    triggerResize(100);
    await flushAnimationFrame();
    expect(harness.viewport.scrollTop).toBe(640);

    scrollHeight = 920;
    triggerResize(220);
    await flushAnimationFrame();
    expect(harness.viewport.scrollTop).toBe(920);

    harness.cleanup();
  });

  it('does not pin content growth when isNearBottom prop is stale during scroll restore', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: true,
    });

    let scrollHeight = 1000;
    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(harness.viewport, 'clientHeight', {
      configurable: true,
      value: 500,
    });
    harness.viewport.scrollTop = 200;

    await flushEffects();

    triggerResize(100);
    await flushAnimationFrame();

    scrollHeight = 1200;
    triggerResize(300);
    await flushAnimationFrame();

    expect(harness.viewport.scrollTop).toBe(200);

    harness.cleanup();
  });

  it('does not pin on content growth when user is away from bottom', async () => {
    const harness = createHarness({
      loadingSession: false,
      messages: [makeMessage('m-1', 0)],
      isNearBottom: false,
    });

    Object.defineProperty(harness.viewport, 'scrollHeight', {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(harness.viewport, 'clientHeight', {
      configurable: true,
      value: 500,
    });
    harness.viewport.scrollTop = 120;

    await flushEffects();

    triggerResize(200);
    await flushAnimationFrame();

    expect(harness.viewport.scrollTop).toBe(120);

    harness.cleanup();
  });
});
