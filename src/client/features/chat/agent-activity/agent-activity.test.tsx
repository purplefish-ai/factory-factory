// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/chat-protocol';
import { MessageItem } from './agent-activity';

it.each(['user', 'assistant', 'thinking'] as const)(
  'renders %s text without a copy action',
  (kind) => {
    const text = 'Text to select and copy';
    const message: ChatMessage = {
      id: kind,
      source: kind === 'user' ? 'user' : 'agent',
      timestamp: '2026-10-31T00:00:00Z',
      order: 0,
      ...(kind === 'user'
        ? { text }
        : {
            message: {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: kind === 'thinking' ? [{ type: 'thinking', thinking: text }] : text,
              },
            },
          }),
    };
    const html = renderToStaticMarkup(createElement(MessageItem, { message }));
    expect(html).toContain(text);
    expect(html).not.toContain('Copy message to clipboard');
  }
);
