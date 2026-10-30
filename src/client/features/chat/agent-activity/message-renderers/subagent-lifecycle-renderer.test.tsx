// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  MessageItem,
  type MessageItemProps,
} from '@/client/features/chat/agent-activity/agent-activity';

it('renders agent lifecycle as its own row and opens Sessions on click', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onOpenAgents = vi.fn();
  const message: MessageItemProps['message'] = {
    id: 'subagent-a-started',
    order: 0,
    source: 'agent',
    timestamp: '2026-10-30T12:00:00Z',
    text: 'Audit capture fix started working',
    message: {
      type: 'system',
      subtype: 'subagent_started',
      text: 'Audit capture fix started working',
      status: 'running',
    },
  };
  flushSync(() => root.render(createElement(MessageItem, { message, onOpenAgents })));
  expect(container.textContent).toBe('Audit capture fix started working');
  expect(container.querySelector('svg')).not.toBeNull();
  flushSync(() => container.querySelector('button')?.click());
  expect(onOpenAgents).toHaveBeenCalledOnce();
  flushSync(() =>
    root.render(
      createElement(MessageItem, {
        message: {
          ...message,
          message: {
            type: 'system',
            subtype: 'subagent_finished',
            status: 'failed',
            text: 'Audit capture fix failed',
          },
        },
      })
    )
  );
  expect(container.textContent).toBe('Audit capture fix failed');
  root.unmount();
});
