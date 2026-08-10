// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/chat-protocol';
import { SessionLifecycleMessageRenderer } from './session-lifecycle-message-renderer';

function lifecycleMessage(
  reason: NonNullable<AgentMessage['lifecycle']>['reason'],
  message: string
) {
  return {
    type: 'session_lifecycle',
    lifecycle: {
      eventId: `event-${reason}`,
      kind: 'SESSION_STOPPED',
      reason,
      message,
      timestamp: '2026-07-30T12:22:23.353Z',
    },
  } satisfies AgentMessage;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SessionLifecycleMessageRenderer', () => {
  it.each([
    ['PROMPT_TIMEOUT', 'Turn stopped: reached the 4-hour limit.', 'warning'],
    ['USER_STOP', 'Session stopped by you.', 'warning'],
    ['SESSION_CLOSED', 'Session closed by you.', 'warning'],
    ['WORKSPACE_ARCHIVED', 'Session stopped because the workspace was archived.', 'warning'],
    ['SYSTEM_STOP', 'Session stopped by the system.', 'warning'],
    ['PROVIDER_ERROR', 'Turn stopped: Codex returned HTTP 529 (Overloaded).', 'error'],
    ['UNEXPECTED_EXIT', 'Session stopped: agent process exited unexpectedly (code 1).', 'error'],
  ] as const)('renders %s copy with %s severity', (reason, copy, severity) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(SessionLifecycleMessageRenderer, { message: lifecycleMessage(reason, copy) })
      );
    });

    expect(container.textContent).toContain(copy);
    expect(
      container
        .querySelector('[data-testid="session-lifecycle-message"]')
        ?.getAttribute('data-severity')
    ).toBe(severity);
    root.unmount();
  });

  it('keeps the timestamp visible and exposes the full copy while the message truncates', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(SessionLifecycleMessageRenderer, {
          message: lifecycleMessage(
            'SYSTEM_STOP',
            'Session stopped because the available horizontal space is intentionally very narrow.'
          ),
        })
      );
    });

    const row = container.querySelector('[data-testid="session-lifecycle-message"]');
    const message = row?.querySelector('p');
    const time = row?.querySelector('time');

    expect(row?.classList.contains('items-center')).toBe(true);
    expect(message?.classList.contains('min-w-0')).toBe(true);
    expect(message?.classList.contains('flex-1')).toBe(true);
    expect(message?.classList.contains('truncate')).toBe(true);
    expect(message?.getAttribute('title')).toBe(
      'Session stopped because the available horizontal space is intentionally very narrow.'
    );
    expect(time?.classList.contains('shrink-0')).toBe(true);
    expect(time?.classList.contains('whitespace-nowrap')).toBe(true);
    expect(message?.nextElementSibling).toBe(time);
    root.unmount();
  });

  it('marks the severity icon as decorative', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(SessionLifecycleMessageRenderer, {
          message: lifecycleMessage('SYSTEM_STOP', 'Session stopped by the system.'),
        })
      );
    });

    const row = container.querySelector('[data-testid="session-lifecycle-message"]');
    expect(row?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    root.unmount();
  });
});
