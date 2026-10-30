// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { type ChatMessage, groupAdjacentToolCalls } from '@/lib/chat-protocol';
import { MessageItem } from './agent-activity';

it.each(['pr-event-cancelled', 'provider-history-id'])(
  'omits the padded wrapper for a cancelled PR update (%s)',
  (id) => {
    const message: ChatMessage = {
      id,
      source: 'agent',
      timestamp: '2026-10-30T00:00:00.000Z',
      order: 0,
      message: {
        type: 'pr_update',
        text: 'PR update cancelled before dispatch',
        prDeliveryState: 'cancelled',
        error: 'Session stopped before dispatch',
      },
    };
    const html = renderToStaticMarkup(createElement(MessageItem, { message }));
    expect(html).toBe('');
  }
);

it.each(['queued', 'committed', 'restored', 'failed'] as const)(
  'shows %s CI events in the chat session',
  (phase) => {
    const text = '<!-- factory-factory-pr-event:ci-delivery -->\nCI_FAILED: test failed';
    const message: ChatMessage = {
      id: phase === 'restored' ? 'provider-history-id' : 'pr-event-ci-delivery',
      source: phase === 'queued' ? 'user' : 'agent',
      text,
      ...(phase === 'queued'
        ? {}
        : {
            message: {
              type: 'pr_update' as const,
              text,
              ...(phase === 'failed' ? { prDeliveryState: phase } : {}),
            },
          }),
      timestamp: '2026-10-08T00:00:00.000Z',
      order: 0,
    };
    expect(groupAdjacentToolCalls([message])).toEqual([message]);
    const html = renderToStaticMarkup(
      createElement(MessageItem, {
        message,
        isQueued: phase === 'queued',
        onRemove: () => undefined,
        userMessageUuid: 'provider-user-id',
        onRewindToMessage: () => undefined,
      })
    );
    expect(html).toContain('PR update');
    expect(html.includes('<details')).toBe(phase !== 'queued');
    expect(html.includes('CI_FAILED: test failed')).toBe(phase !== 'queued');
    expect(html.includes('queued for next turn')).toBe(phase === 'queued');
    if (phase === 'failed') {
      expect(html).toContain(`PR update · ${phase}`);
    }
    expect(html).not.toContain('factory-factory-pr-event');
    expect(html).not.toContain('Rewind');
    expect(html).not.toContain('Remove');
  }
);
