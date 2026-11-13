// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { MessageState } from '@/lib/chat-protocol';
import { createUserMessage } from '@/lib/claude.fixture';
import type { PendingMessageContent } from './reducer';
import { TranscriptRenderingFixture } from './transcript-rendering.test-harness';
import { useChatState, type UseChatStateReturn } from './use-chat-state';

function SendingHarness({ chatRef }: { chatRef: { current: UseChatStateReturn | null } }) {
  const chat = useChatState({ dbSessionId: 'session-A', connected: true, send: () => true });
  chatRef.current = chat;
  return (
    <>
      <textarea readOnly value={chat.inputDraft} />
      <TranscriptRenderingFixture
        sessionId="session-A"
        messages={chat.messages}
        pendingMessages={chat.pendingMessages}
        running={false}
        startingSession={false}
        loadingSession={false}
      />
    </>
  );
}

it.each([false, true])('shows an image send before confirmation (loading=%s)', (loadingSession) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const message = createUserMessage('Look at this image', 1);
  const pending: PendingMessageContent = {
    text: message.text ?? '',
    sessionId: 'session-A',
    attachments: [
      {
        id: 'image-1',
        name: 'example.png',
        type: 'image/png',
        size: 1,
        contentType: 'image',
        data: 'aGVsbG8=',
      },
    ],
  };
  const render = (confirmed: boolean) =>
    flushSync(() =>
      root.render(
        <TranscriptRenderingFixture
          sessionId="session-A"
          messages={confirmed ? [{ ...message, attachments: pending.attachments }] : []}
          pendingMessages={confirmed ? new Map() : new Map([[message.id, pending]])}
          queuedMessageIds={confirmed ? new Set([message.id]) : new Set()}
          running={false}
          startingSession={false}
          loadingSession={loadingSession}
        />
      )
    );
  try {
    render(false);
    expect(container.textContent).toContain('Look at this image');
    expect(container.textContent).toContain('Sending…');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('aGVsbG8=');
    expect(container.querySelector('button[aria-label="Cancel queued message"]')).toBeNull();
    render(true);
    expect(container.textContent?.match(/Look at this image/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('Sending…');
    expect(container.querySelector('img')).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
  }
});

it('deduplicates pending sends against server history and isolates other sessions', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const confirmed = createUserMessage('Confirmed message', 1);
  try {
    flushSync(() =>
      root.render(
        <TranscriptRenderingFixture
          sessionId="session-A"
          messages={[confirmed]}
          pendingMessages={
            new Map([
              [confirmed.id, { text: 'Stale local content', sessionId: 'session-A' }],
              ['other-session', { text: 'Private other draft', sessionId: 'session-B' }],
              ['first-send', { text: 'First pending', sessionId: 'session-A' }],
              ['second-send', { text: 'Second pending', sessionId: 'session-A' }],
            ])
          }
          running={false}
          startingSession={false}
          loadingSession={false}
        />
      )
    );
    expect(container.textContent).toContain('Confirmed message');
    expect(container.textContent).not.toContain('Stale local content');
    expect(container.textContent).not.toContain('Private other draft');
    expect(container.textContent?.match(/Sending…/g)).toHaveLength(2);
    expect(container.textContent).toContain('First pending');
    expect(container.textContent).toContain('Second pending');
    expect(container.textContent?.indexOf('First pending')).toBeLessThan(
      container.textContent?.indexOf('Second pending') ?? 0
    );
  } finally {
    flushSync(() => root.unmount());
  }
});

it('keeps a sent image visible from composer clearing through confirmation', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const ref: { current: UseChatStateReturn | null } = { current: null };

  try {
    flushSync(() => root.render(<SendingHarness chatRef={ref} />));
    flushSync(() => {
      ref.current?.setInputDraft('Describe my image');
      ref.current?.setInputAttachments([
        {
          id: 'image',
          name: 'photo.png',
          type: 'image/png',
          size: 1,
          contentType: 'image',
          data: 'aGVsbG8=',
        },
      ]);
    });
    flushSync(() => ref.current?.sendMessage('Describe my image'));
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(container.textContent).toContain('Describe my image');
    expect(container.textContent).toContain('Sending…');
    expect(container.querySelector('img')).not.toBeNull();
    const id = ref.current?.pendingMessages.keys().next().value;
    expect(id).toBeDefined();
    if (!id) {
      throw new Error('Missing pending send');
    }
    flushSync(() =>
      ref.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id,
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: 'Describe my image',
            timestamp: new Date().toISOString(),
            attachments: ref.current.pendingMessages.get(id)?.attachments,
          },
        },
      })
    );
    expect(container.textContent?.match(/Describe my image/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('Sending…');
    expect(container.querySelector('img')).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
    sessionStorage.clear();
  }
});
