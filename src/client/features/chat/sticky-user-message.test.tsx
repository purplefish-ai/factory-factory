// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantMessage, createUserMessage } from '@/lib/claude.fixture';
import { WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX } from '@/shared/workspace-notifications';
import { StickyUserMessage } from './sticky-user-message';

type Props = ComponentProps<typeof StickyUserMessage>;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mount(messages: Props['messages'], headerOffset = 0) {
  const container = document.createElement('div');
  const viewport = document.createElement('div');
  const root = createRoot(container);
  const onJump = vi.fn();
  // Rows need not be mounted: the virtualizer retains their geometry.
  let rows = Array.from({ length: messages.length + headerOffset }, (_, index) => ({
    index,
    start: index * 200,
    end: index * 200 + 100,
  }));
  let props: Props = {
    viewport,
    engine: {
      getVirtualItemForOffset: (offset) => rows.findLast((row) => row.start <= offset) ?? rows[0],
    },
    messages,
    headerOffset,
    pendingMessageIds: new Set(),
    enabled: true,
    onJump,
  };
  const render = (changes: Partial<Props> = {}) => {
    props = { ...props, ...changes };
    flushSync(() => root.render(<StickyUserMessage {...props} />));
  };
  const scroll = (top: number) => {
    viewport.scrollTop = top;
    flushSync(() => viewport.dispatchEvent(new Event('scroll')));
  };
  cleanups.push(() => root.unmount());
  render();
  return {
    container,
    onJump,
    render,
    scroll,
    resize: (next: typeof rows) => {
      rows = next;
      render();
    },
    button: () => container.querySelector('button'),
  };
}

describe('StickyUserMessage', () => {
  it('pins the request above the reading position and jumps to that request', () => {
    const first = createUserMessage('First task\nwith more context');
    const latest = createUserMessage('Current task');
    const view = mount([
      first,
      createAssistantMessage('First response'),
      latest,
      createAssistantMessage('Current response'),
    ]);
    view.scroll(280);
    expect(view.button()?.textContent).toContain('First task with more context');
    flushSync(() => view.button()?.click());
    expect(view.onJump).toHaveBeenLastCalledWith(first.id);
    view.scroll(680);
    expect(view.button()?.textContent).toContain('Current task');
    flushSync(() => view.button()?.click());
    expect(view.onJump).toHaveBeenLastCalledWith(latest.id);
    view.scroll(280);
    expect(view.button()?.textContent).toContain('First task with more context');
    view.scroll(0);
    expect(view.button()).toBeNull();
  });

  it('waits until the whole prompt is 56px above the viewport, in either direction', () => {
    const view = mount([createUserMessage('Task'), createAssistantMessage('Response')]);
    for (const top of [0, 50, 100, 101, 155]) {
      view.scroll(top);
      expect(view.button()).toBeNull();
    }
    view.scroll(156);
    expect(view.button()?.textContent).toContain('Task');
    view.scroll(155);
    expect(view.button()).toBeNull();
  });

  it('hides the previous preview before an incoming prompt enters its 40px area', () => {
    const view = mount([
      createUserMessage('First task'),
      createAssistantMessage('First response'),
      createUserMessage('Next task'),
      createAssistantMessage('Next response'),
    ]);
    view.scroll(359);
    expect(view.button()?.textContent).toContain('First task');
    for (const top of [360, 400, 450, 501, 555]) {
      view.scroll(top);
      expect(view.button()).toBeNull();
    }
    view.scroll(556);
    expect(view.button()?.textContent).toContain('Next task');
    view.scroll(450);
    expect(view.button()).toBeNull();
    view.scroll(359);
    expect(view.button()?.textContent).toContain('First task');
  });

  it('ignores notifications, queued prompts and pending sends', () => {
    const sent = createUserMessage('Sent task');
    const notification = {
      ...createUserMessage('Workspace notification'),
      id: `${WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX}notice`,
    };
    const queued = createUserMessage('Next task');
    const pending = createUserMessage('Still sending');
    const view = mount([sent, notification, queued, pending, createAssistantMessage('Response')]);
    view.render({
      queuedMessageIds: new Set([queued.id]),
      pendingMessageIds: new Set([pending.id]),
    });
    view.scroll(850);
    expect(view.button()?.textContent).toContain('Sent task');
  });

  it('accounts for the history header without pinning it', () => {
    const view = mount([createUserMessage('Task'), createAssistantMessage('Response')], 1);
    view.scroll(100);
    expect(view.button()).toBeNull();
    view.scroll(355);
    expect(view.button()).toBeNull();
    view.scroll(356);
    expect(view.button()?.textContent).toContain('Task');
  });

  it('keeps the reading context when a new prompt arrives below the viewport', () => {
    const first = createUserMessage('Reading this task');
    const response = createAssistantMessage('Response');
    const view = mount([first, response]);
    view.scroll(280);
    view.render({ messages: [first, response, createUserMessage('New task')] });
    expect(view.button()?.textContent).toContain('Reading this task');
  });

  it('rechecks the geometry after a prompt changes size', () => {
    const view = mount([createUserMessage('Task'), createAssistantMessage('Response')]);
    view.scroll(280);
    expect(view.button()).not.toBeNull();
    view.resize([
      { index: 0, start: 0, end: 250 },
      { index: 1, start: 350, end: 450 },
    ]);
    expect(view.button()).toBeNull();
    view.scroll(306);
    expect(view.button()?.textContent).toContain('Task');
  });

  it('updates the matching request after history is prepended', () => {
    const current = createUserMessage('Current task');
    const response = createAssistantMessage('Response');
    const view = mount([current, response]);
    view.scroll(280);
    view.render({
      messages: [
        createUserMessage('Older task'),
        createAssistantMessage('Older reply'),
        current,
        response,
      ],
    });
    view.resize(
      Array.from({ length: 4 }, (_, index) => ({
        index,
        start: index * 200,
        end: index * 200 + 100,
      }))
    );
    view.scroll(680);
    expect(view.button()?.textContent).toContain('Current task');
    view.scroll(280);
    expect(view.button()?.textContent).toContain('Older task');
  });

  it('hides when disabled, without a viewport or geometry, or without a sent prompt', () => {
    const messages = [createUserMessage('Task'), createAssistantMessage('Response')];
    const view = mount(messages);
    view.scroll(280);
    expect(view.button()).not.toBeNull();
    view.render({ enabled: false });
    expect(view.button()).toBeNull();
    view.render({ enabled: true, viewport: null });
    expect(view.button()).toBeNull();
    view.render({ messages: [] });
    expect(view.button()).toBeNull();
    const onlyReply = mount([createAssistantMessage('Response')]);
    onlyReply.scroll(280);
    expect(onlyReply.button()).toBeNull();
    const unmeasured = mount(messages);
    unmeasured.scroll(280);
    unmeasured.resize([]);
    expect(unmeasured.button()).toBeNull();
  });

  it('offers an attachment fallback when the request has no text', () => {
    const view = mount([createUserMessage(''), createAssistantMessage('Response')]);
    view.scroll(280);
    expect(view.button()?.textContent).toContain('Attached files');
  });
});
