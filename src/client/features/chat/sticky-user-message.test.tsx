// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createUserMessage } from '@/lib/claude.fixture';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';
import { StickyUserMessage } from './sticky-user-message';

describe('StickyUserMessage', () => {
  it('appears only after the latest sent prompt leaves view and jumps to that prompt', () => {
    const container = document.createElement('div');
    const viewport = document.createElement('div');
    const root = createRoot(container);
    const first = createUserMessage('First task');
    const latest = createUserMessage('Current task\nwith more context');
    const notification = {
      ...createUserMessage('Workspace notification'),
      id: `${WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX}notice`,
    };
    const queued = createUserMessage('Next task');
    const pending = createUserMessage('Still sending');
    const onJump = vi.fn();
    let topRow = { index: 2, end: 300 };
    const engine = { getVirtualItemForOffset: () => topRow };
    const render = () =>
      flushSync(() =>
        root.render(
          <StickyUserMessage
            viewport={viewport}
            engine={engine}
            messages={[first, latest, notification, queued, pending]}
            headerOffset={1}
            queuedMessageIds={new Set([queued.id])}
            pendingMessageIds={new Set([pending.id])}
            enabled
            onJump={onJump}
          />
        )
      );
    try {
      render();
      expect(container.querySelector('button')).toBeNull();
      viewport.scrollTop = 301;
      flushSync(() => viewport.dispatchEvent(new Event('scroll')));
      const button = container.querySelector('button');
      expect(button?.textContent).toContain('Current task with more context');
      flushSync(() => button?.click());
      expect(onJump).toHaveBeenCalledWith(latest.id);
      viewport.scrollTop = 0;
      topRow = { index: 1, end: 100 };
      flushSync(() => viewport.dispatchEvent(new Event('scroll')));
      expect(container.querySelector('button')).toBeNull();
      topRow = { index: 4, end: 500 };
      render();
      expect(container.querySelector('button')).not.toBeNull();
    } finally {
      root.unmount();
    }
  });

  it('updates for a new prompt and hides during loading or empty conversations', () => {
    const container = document.createElement('div');
    const viewport = document.createElement('div');
    const root = createRoot(container);
    const old = createUserMessage('Old task');
    const latest = createUserMessage('New task');
    const engine = { getVirtualItemForOffset: () => ({ index: 1, end: 300 }) };
    const render = (messages = [old], enabled = true) =>
      flushSync(() =>
        root.render(
          <StickyUserMessage
            viewport={viewport}
            engine={engine}
            messages={messages}
            headerOffset={0}
            pendingMessageIds={new Set()}
            enabled={enabled}
            onJump={vi.fn()}
          />
        )
      );
    try {
      render();
      expect(container.textContent).toContain('Old task');
      render([old, latest]);
      expect(container.querySelector('button')).toBeNull();
      viewport.scrollTop = 301;
      flushSync(() => viewport.dispatchEvent(new Event('scroll')));
      expect(container.textContent).toContain('New task');
      render([old, latest], false);
      expect(container.querySelector('button')).toBeNull();
      render([]);
      expect(container.querySelector('button')).toBeNull();
      render([{ ...old, text: '', attachments: [] }]);
      expect(container.textContent).toContain('Attached files');
    } finally {
      root.unmount();
    }
  });
});
