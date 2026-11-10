// @vitest-environment jsdom
import { useReducer, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createUserMessage } from '@/lib/claude-fixtures';
import { chatReducer, createInitialChatState } from './reducer';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';
import { useChatActions, type UseChatActionsOptions } from './use-chat-actions';

const queued = createUserMessage('Focus on the failing tests', 1);
const history = createUserMessage('Earlier message', 0);

function SteeringFixture({
  send,
  dispatch,
  onClearInput,
}: Pick<UseChatActionsOptions, 'send' | 'dispatch' | 'onClearInput'>) {
  const [state, reduce] = useReducer(chatReducer, undefined, createInitialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const actions = useChatActions({
    send,
    dispatch: (action) => {
      dispatch(action);
      reduce(action);
    },
    stateRef,
    dbSessionIdRef: useRef('session'),
    inputAttachmentsRef: useRef([]),
    onClearInput,
  });
  return (
    <TranscriptRenderingFixture
      messages={[history, queued]}
      queuedMessageIds={new Set([queued.id])}
      onSteerQueuedMessage={actions.steerQueuedMessage}
      pendingSteerMessageId={state.pendingSteer?.messageId}
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
    flushSync(() => {
      buttons[0]?.click();
      buttons[0]?.click();
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: 'steer_queued_message', messageId: queued.id, requestId: expect.any(String) },
      { queuePolicy: 'drop' }
    );
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[0]?.textContent).toContain('Steering');
    flushSync(() => buttons[0]?.click());
    expect(send).toHaveBeenCalledTimes(1);
    expect(onClearInput).not.toHaveBeenCalled();
    expect(container.textContent).toContain(queued.text);
  } finally {
    flushSync(() => root.unmount());
  }
});

it('keeps the message DOM mounted when dequeued and removes its queue actions', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (isQueued: boolean) => (
    <TranscriptRenderingFixture
      messages={[queued]}
      queuedMessageIds={new Set(isQueued ? [queued.id] : [])}
      onSteerQueuedMessage={vi.fn()}
      onRemoveQueuedMessage={vi.fn()}
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
    // Automatic notifications have dedicated rows without user-message controls.
    if (id === 'command') {
      expect(actions?.style.gridTemplateRows).toBe('0fr');
    } else {
      expect(actions).toBeNull();
    }
  } finally {
    flushSync(() => root.unmount());
  }
});

it('leaves Steer available when the transport cannot send the request', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const send = vi.fn(() => false);
  try {
    flushSync(() =>
      root.render(<SteeringFixture send={send} dispatch={vi.fn()} onClearInput={vi.fn()} />)
    );
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Steer queued message"]'
    )!;
    flushSync(() => button.click());
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Steer');
    flushSync(() => button.click());
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    flushSync(() => root.unmount());
  }
});
