// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { useGroupedChatMessages } from './use-grouped-chat-messages';

it('updates duplicate filtering when options change with the same message array', () => {
  const messages: ChatMessage[] = [
    {
      id: 'answer',
      source: 'agent',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'same' }] },
      },
      timestamp: '2026-09-08T00:00:00.000Z',
      order: 0,
    },
    {
      id: 'result',
      source: 'agent',
      message: { type: 'result', result: 'same' },
      timestamp: '2026-09-08T00:00:00.000Z',
      order: 1,
    },
  ];
  function Harness({ filterDuplicateResults }: { filterDuplicateResults?: boolean }) {
    const grouped = useGroupedChatMessages(messages, { filterDuplicateResults });
    return createElement('div', null, grouped.map((item) => item.id).join(','));
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (filterDuplicateResults?: boolean) => {
    flushSync(() => root.render(createElement(Harness, { filterDuplicateResults })));
    return container.textContent;
  };

  try {
    expect(render()).toBe('answer,result');
    expect(render(true)).toBe('answer');
    expect(render(true)).toBe('answer');
    expect(render(false)).toBe('answer,result');
    expect(render()).toBe('answer,result');
  } finally {
    flushSync(() => root.unmount());
  }
});
