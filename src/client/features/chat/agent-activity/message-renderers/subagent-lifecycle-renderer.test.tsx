// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  MessageItem,
  type MessageItemProps,
} from '@/client/features/chat/agent-activity/agent-activity';
import { TranscriptRenderingFixture } from '../../transcript-rendering.test-utils';

it.each([
  ['subagent_started', 'running', 'started working'],
  ['subagent_finished', 'completed', 'finished'],
  ['subagent_finished', 'cancelled', 'cancelled'],
  ['subagent_finished', 'interrupted', 'interrupted'],
  ['subagent_finished', 'failed', 'failed'],
] as const)('opens the sub-agent tab for %s / %s rows', (subtype, status, label) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onOpenSubagent = vi.fn();
  const message: MessageItemProps['message'] = {
    id: 'subagent-a-started',
    subagentId: 'child-a',
    order: 0,
    source: 'agent',
    timestamp: '2026-10-30T12:00:00Z',
    text: `Audit capture fix ${label}`,
    message: {
      type: 'system',
      subtype,
      text: `Audit capture fix ${label}`,
      status,
    },
  };
  flushSync(() =>
    root.render(
      createElement(TranscriptRenderingFixture, {
        messages: [message],
        running: false,
        startingSession: false,
        loadingSession: false,
        onOpenSubagent,
      })
    )
  );
  expect(container.textContent).toBe(`Audit capture fix ${label}`);
  expect(container.querySelector('svg')).not.toBeNull();
  flushSync(() => container.querySelector('button')?.click());
  expect(onOpenSubagent).toHaveBeenCalledExactlyOnceWith('child-a');
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

it('keeps lifecycle rows without a sub-agent identity non-interactive', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    flushSync(() =>
      root.render(
        createElement(MessageItem, {
          onOpenSubagent: vi.fn(),
          message: {
            id: 'legacy',
            source: 'agent',
            order: 0,
            timestamp: '2026-10-30T12:00:00Z',
            message: {
              type: 'system',
              subtype: 'subagent_started',
              text: 'Sub-agent started working',
            },
          },
        })
      )
    );
    expect(container.textContent).toBe('Sub-agent started working');
    expect(container.querySelector('button')).toBeNull();
  } finally {
    flushSync(() => root.unmount());
  }
});
