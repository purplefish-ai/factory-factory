// @vitest-environment jsdom
import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import { VirtualizedMessageList } from './virtualized-message-list';

const mocks = vi.hoisted(() => ({ observers: new Set<ResizeObserverCallback>(), append: vi.fn() }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    measureElement: vi.fn(),
    scrollToIndex: mocks.append,
  }),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(private callback: ResizeObserverCallback) {
      mocks.observers.add(callback);
    }
    observe() {
      /* Measurements are explicitly delivered by each regression. */
    }
    disconnect() {
      mocks.observers.delete(this.callback);
    }
  }
);

afterEach(() => {
  mocks.observers.clear();
  mocks.append.mockClear();
});
function resize(height: number) {
  const entry: ResizeObserverEntry = {
    target: document.body,
    contentRect: new DOMRect(0, 0, 0, height),
    borderBoxSize: [{ inlineSize: 0, blockSize: height }],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  mocks.observers.forEach((callback) => callback([entry], {} as ResizeObserver));
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const message: GroupedMessageItem = {
  id: 'm1',
  source: 'user',
  text: 'test',
  order: 1,
  timestamp: '2026-10-30T00:00:00Z',
};

function harness() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const viewport = document.createElement('div');
  const ref = createRef<HTMLDivElement>();
  ref.current = viewport;
  let height = 1000;
  let top = 500;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 500 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, height - 500);
      },
    },
  });
  const render = (following = true, messages = [message]) =>
    flushSync(() =>
      root.render(
        <VirtualizedMessageList
          messages={messages}
          running={false}
          startingSession={false}
          loadingSession={false}
          scrollContainerRef={ref}
          isNearBottom={following}
        />
      )
    );
  render();
  return {
    viewport,
    render,
    grow: (value: number) => {
      height = value;
      resize(value);
    },
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}

// Documented legacy failures; replaced by controller/browser regressions in Task 3.
it.fails('legacy resize correction yields to upward user movement before its frame', async () => {
  const view = harness();
  try {
    resize(1000);
    view.viewport.scrollTop = 100;
    view.viewport.dispatchEvent(new Event('scroll'));
    view.render(false);
    await frame();
    expect(view.viewport.scrollTop).toBe(100);
  } finally {
    view.dispose();
  }
});

it.fails('legacy growth callbacks retain follow intent before the next frame', async () => {
  const view = harness();
  try {
    resize(1000);
    await frame();
    view.grow(1200);
    view.grow(1400);
    mocks.append.mockClear();
    view.render(true, [message, { ...message, id: 'm2' }]);
    expect(mocks.append).toHaveBeenCalled();
  } finally {
    view.dispose();
  }
});
