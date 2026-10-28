// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { useGroupedChatMessages } from './use-grouped-chat-messages';
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

function History({ messages, running }: { messages: ChatMessage[]; running: boolean }) {
  const grouped = useGroupedChatMessages(messages);
  return createElement(VirtualizedMessageList, {
    messages: grouped,
    running,
    startingSession: false,
    loadingSession: false,
    latestThinking: 'Checking the next step',
    scrollContainerRef: { current: null },
  });
}

it.each(['', 'Internal reasoning'])(
  'hides historical thinking rows (%j) and preserves live activity',
  (thinking) => {
    const timestamp = '2026-10-28T00:00:00.000Z';
    const messages: ChatMessage[] = [
      { id: 'question', source: 'user', text: 'What changed?', timestamp, order: 0 },
      {
        id: 'thinking',
        source: 'agent',
        timestamp,
        order: 1,
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
        },
      },
      {
        id: 'stream-thinking',
        source: 'agent',
        timestamp,
        order: 1.5,
        message: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking },
          },
        },
      },
      {
        id: 'answer',
        source: 'agent',
        timestamp,
        order: 2,
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The fix is ready.' }] },
        },
      },
    ];
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(createElement(History, { messages, running: false })));
      expect(container.textContent).toContain('What changed?');
      expect(container.textContent).toContain('The fix is ready.');
      expect(container.textContent).not.toContain('Thinking');
      expect(container.querySelectorAll('[data-index]')).toHaveLength(2);

      flushSync(() =>
        root.render(createElement(History, { messages: [...messages], running: true }))
      );
      expect(container.textContent).toContain('Checking the next step');
      expect(container.querySelectorAll('[data-index]')).toHaveLength(2);
    } finally {
      flushSync(() => root.unmount());
    }
  }
);
