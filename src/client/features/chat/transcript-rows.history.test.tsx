// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';
import { useGroupedChatMessages } from './use-grouped-chat-messages';

function History({ messages, running }: { messages: ChatMessage[]; running: boolean }) {
  const grouped = useGroupedChatMessages(messages);
  return createElement(TranscriptRenderingFixture, {
    messages: grouped,
    running,
    startingSession: false,
    loadingSession: false,
    latestThinking: 'Checking the next step',
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
        order: 2,
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
        order: 3,
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

      const appendedMessages: ChatMessage[] = [
        ...messages,
        {
          id: 'appended-thinking',
          source: 'agent',
          timestamp,
          order: 4,
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
          },
        },
        {
          id: 'appended-stream-thinking',
          source: 'agent',
          timestamp,
          order: 5,
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking },
            },
          },
        },
      ];
      flushSync(() =>
        root.render(createElement(History, { messages: appendedMessages, running: true }))
      );
      expect(container.textContent).toContain('Checking the next step');
      expect(container.textContent).not.toContain('Thinking');
      expect(container.querySelectorAll('[data-index]')).toHaveLength(2);

      const nextAnswer: ChatMessage = {
        id: 'next-answer',
        source: 'agent',
        timestamp,
        order: 6,
        message: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The next step is done.' }],
          },
        },
      };
      flushSync(() =>
        root.render(
          createElement(History, { messages: [...appendedMessages, nextAnswer], running: false })
        )
      );
      expect(container.textContent).toContain('The fix is ready.');
      expect(container.textContent).toContain('The next step is done.');
      expect(container.textContent).not.toContain('Thinking');
      expect(container.querySelectorAll('[data-index]')).toHaveLength(3);
    } finally {
      flushSync(() => root.unmount());
    }
  }
);
