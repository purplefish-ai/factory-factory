// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

let copyTestRoot: Root | null = null;

afterEach(() => {
  copyTestRoot?.unmount();
  copyTestRoot = null;
  Reflect.deleteProperty(navigator, 'clipboard');
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

  it('wraps warning copy instead of hiding it in a tooltip, keeping the timestamp visible', () => {
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

    expect(message?.classList.contains('min-w-0')).toBe(true);
    expect(message?.classList.contains('flex-1')).toBe(true);
    expect(message?.classList.contains('break-words')).toBe(true);
    expect(message?.classList.contains('truncate')).toBe(false);
    expect(time?.classList.contains('shrink-0')).toBe(true);
    expect(time?.classList.contains('whitespace-nowrap')).toBe(true);
    expect(message?.nextElementSibling).toBe(time);
    expect(row?.querySelector('button')).toBeNull();
    root.unmount();
  });

  it('expands error rows inline to the full text and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const longError = `Turn stopped: provider returned 400 ${'{"error":"invalid_request"} '.repeat(20)}`;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    copyTestRoot = root;

    flushSync(() => {
      root.render(
        createElement(SessionLifecycleMessageRenderer, {
          message: lifecycleMessage('PROVIDER_ERROR', longError),
        })
      );
    });

    const row = container.querySelector('[data-testid="session-lifecycle-message"]');
    const message = row?.querySelector('p');
    const toggle = row?.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(message?.classList.contains('truncate')).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Show full error');
    expect(toggle?.getAttribute('aria-controls')).toBe(message?.id);
    expect(row?.querySelector('button[aria-label="Copy error"]')).toBeNull();

    flushSync(() => toggle?.click());

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Collapse error');
    const details = row?.querySelector(`[id="${toggle?.getAttribute('aria-controls')}"]`);
    expect(details?.classList.contains('truncate')).toBe(false);
    expect(details?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(details?.textContent).toBe(longError);

    const copyButton = row?.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]');
    flushSync(() => copyButton?.click());
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(longError));
    await vi.waitFor(() =>
      expect(row?.querySelector('button[aria-label="Error copied"]')).not.toBeNull()
    );
    expect(row?.querySelector('[role="status"]')?.textContent).toBe(
      'Error copied to the clipboard'
    );

    flushSync(() => toggle?.click());
    expect(row?.querySelector('p')?.classList.contains('truncate')).toBe(true);
    expect(row?.querySelectorAll('p')).toHaveLength(1);
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
