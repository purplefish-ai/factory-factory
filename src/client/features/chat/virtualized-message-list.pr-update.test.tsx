// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { VirtualizedMessageList } from './virtualized-message-list';

// jsdom has no viewport measurements; expose all rows while keeping rendering real.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80 })),
    getTotalSize: () => count * 80,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

it('keeps a queued PR update below live thinking, then returns it to the transcript on delivery', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const update: ChatMessage = {
    id: 'pr-event-queued-test',
    source: 'user',
    order: 1,
    timestamp: '2026-10-28T00:00:00.000Z',
    text: 'PR update queued for the next turn',
  };
  const render = (queued: boolean) =>
    flushSync(() =>
      root.render(
        createElement(VirtualizedMessageList, {
          messages: [
            queued
              ? update
              : { ...update, source: 'agent', message: { type: 'pr_update', text: 'CI failed' } },
          ],
          queuedMessageIds: new Set(queued ? [update.id] : []),
          running: true,
          startingSession: false,
          loadingSession: false,
          latestThinking: 'Considering the implementation',
          scrollContainerRef: { current: container },
        })
      )
    );
  try {
    render(true);
    expect(container.textContent).toContain('Considering the implementation');
    expect(container.textContent?.match(/PR update/g)).toHaveLength(1);
    expect(container.textContent!.indexOf('Considering the implementation')).toBeLessThan(
      container.textContent!.indexOf('PR update')
    );
    expect(container.querySelector('details')).toBeNull();
    render(false);
    expect(container.textContent).toContain('Considering the implementation');
    expect(container.textContent?.match(/PR update/g)).toHaveLength(1);
    expect(container.textContent!.indexOf('PR update')).toBeLessThan(
      container.textContent!.indexOf('Considering the implementation')
    );
    expect(container.querySelector('details')).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
