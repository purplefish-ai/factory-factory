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

afterEach(() => {
  virtualizerMocks.getVirtualItems.mockClear();
  virtualizerMocks.getTotalSize.mockClear();
  virtualizerMocks.measureElement.mockClear();
  virtualizerMocks.scrollToIndex.mockClear();
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
});
