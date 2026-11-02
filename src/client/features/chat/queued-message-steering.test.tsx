// @vitest-environment jsdom
import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createUserMessage } from '@/lib/claude-fixtures';
import { createInitialChatState } from './reducer';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';
import { useChatActions, type UseChatActionsOptions } from './use-chat-actions';

const queued = createUserMessage('Focus on the failing tests', 1);
const history = createUserMessage('Earlier message', 0);

function SteeringFixture({
  send,
  dispatch,
  onClearInput,
}: Pick<UseChatActionsOptions, 'send' | 'dispatch' | 'onClearInput'>) {
  const actions = useChatActions({
    send,
    dispatch,
    stateRef: useRef(createInitialChatState()),
    dbSessionIdRef: useRef('session'),
    inputAttachmentsRef: useRef([]),
    rewindTimeoutRef: useRef(null),
    onClearInput,
  });
  return (
    <TranscriptRenderingFixture
      messages={[history, queued]}
      queuedMessageIds={new Set([queued.id])}
      onSteerQueuedMessage={actions.steerQueuedMessage}
      running
      startingSession={false}
      loadingSession={false}
    />
  );
}

it('steers the selected queued message without removing it before delivery is confirmed', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const send = vi.fn(() => true);
  const dispatch = vi.fn();
  const onClearInput = vi.fn();
  try {
    flushSync(() =>
      root.render(<SteeringFixture send={send} dispatch={dispatch} onClearInput={onClearInput} />)
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Steer queued message"]'
    );
    expect(buttons).toHaveLength(1);
    flushSync(() => buttons[0]?.click());
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: 'steer_queued_message', messageId: queued.id },
      { queuePolicy: 'drop' }
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(onClearInput).not.toHaveBeenCalled();
    expect(container.textContent).toContain(queued.text);
  } finally {
    flushSync(() => root.unmount());
  }
});

it('keeps the message DOM mounted when dequeued and replaces queue actions with rewind', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (isQueued: boolean) => (
    <TranscriptRenderingFixture
      messages={[queued]}
      queuedMessageIds={new Set(isQueued ? [queued.id] : [])}
      onSteerQueuedMessage={vi.fn()}
      onRemoveQueuedMessage={vi.fn()}
      getUuidForMessageId={() => 'user-uuid'}
      onRewindToMessage={vi.fn()}
      running
      startingSession={false}
      loadingSession={false}
    />
  );
  try {
    flushSync(() => root.render(render(true)));
    const row = container.querySelector('[data-transcript-key]');
    const message = Array.from(container.querySelectorAll('div')).find(
      (element) => element.textContent === queued.text && element.children.length === 0
    );
    expect(message).toBeDefined();
    expect(container.querySelector('button[aria-label="Cancel queued message"]')).not.toBeNull();
    flushSync(() => root.render(render(false)));
    expect(container.querySelector('[data-transcript-key]')).toBe(row);
    expect(container.contains(message ?? null)).toBe(true);
    expect(container.querySelector('button[aria-label="Steer queued message"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Cancel queued message"]')).toBeNull();
    expect(
      container.querySelector('button[aria-label="Rewind files to before this message"]')
    ).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
  }
});

it.each([
  { id: 'pr-event-update', text: 'Automatic update' },
  { id: 'workspace-notification-update', text: 'Automatic update' },
  { id: 'command', text: '/compact' },
])('does not offer steering for reserved or command queued message $id', ({ id, text }) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const queued = { ...createUserMessage(text), id };
  try {
    flushSync(() =>
      root.render(
        <TranscriptRenderingFixture
          messages={[queued]}
          queuedMessageIds={new Set([id])}
          onSteerQueuedMessage={vi.fn()}
          running
          startingSession={false}
          loadingSession={false}
        />
      )
    );
    expect(container.querySelector('button[aria-label="Steer queued message"]')).toBeNull();
    const actions = container.querySelector<HTMLElement>('[style*="grid-template-rows"]');
    // PR updates render their own card; other ineligible messages collapse the empty controls row.
    if (id !== 'pr-event-update') {
      expect(actions?.style.gridTemplateRows).toBe('0fr');
    }
  } finally {
    flushSync(() => root.unmount());
  }
});
