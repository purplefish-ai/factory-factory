// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseChatStateReturn, useChatState } from '@/client/features/chat/use-chat-state';
import type { ChatMessage } from '@/lib/chat-protocol';
import { TextRenderer } from './agent-activity/message-renderers/stream-event-renderer';
import { StreamingTextProvider } from './agent-activity/message-renderers/streaming-text-context';
import { STREAM_DELTA_WINDOW_MS } from './stream-delta-coalescer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const send = () => true;

interface ChatStateHarnessProps {
  dbSessionId: string;
  connected: boolean;
  chatRef: { current: UseChatStateReturn | null };
  renders: { count: number };
  showReply: boolean;
}

function ChatStateHarness({
  dbSessionId,
  connected,
  chatRef,
  renders,
  showReply,
}: ChatStateHarnessProps) {
  renders.count += 1;
  const chat = useChatState({ dbSessionId, send, connected });
  chatRef.current = chat;
  if (!showReply) {
    return null;
  }
  // The streaming reply, rendered as the transcript renders it.
  return (
    <StreamingTextProvider streamingMessageId="assistant-1">
      <TextRenderer text={assistantText(chat.messages) ?? ''} messageId="assistant-1" />
    </StreamingTextProvider>
  );
}

function renderChatState(initialSessionId: string, { showReply = false } = {}) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const chatRef: { current: UseChatStateReturn | null } = { current: null };
  const renders = { count: 0 };
  let sessionId = initialSessionId;
  let connected = true;

  const render = () =>
    root.render(
      createElement(ChatStateHarness, {
        dbSessionId: sessionId,
        connected,
        chatRef,
        renders,
        showReply,
      })
    );
  act(render);

  const chat = () => {
    if (!chatRef.current) {
      throw new Error('Expected chat state');
    }
    return chatRef.current;
  };
  return {
    chat,
    container,
    renders,
    setConnected: (value: boolean) => {
      connected = value;
      act(render);
    },
    switchSession: (value: string) => {
      sessionId = value;
      act(render);
    },
    unmount: () => act(() => root.unmount()),
  };
}

type Harness = ReturnType<typeof renderChatState>;

function assistantText(messages: ChatMessage[]): string | null {
  const content = messages.find((message) => message.order === 1)?.message;
  if (content?.type !== 'assistant' || !Array.isArray(content.message?.content)) {
    return null;
  }
  const first = content.message.content[0];
  return first?.type === 'text' ? first.text : null;
}

/** Each delta arrives in its own task, 25 ms apart, as the backend flushes them. */
function receiveDeltas(harness: Harness, chunks: string[], startOffset: number) {
  let offset = startOffset;
  for (const text of chunks) {
    act(() => {
      vi.advanceTimersByTime(25);
      harness.chat().handleMessage({
        type: 'assistant_text_delta',
        messageId: 'assistant-1',
        order: 1,
        offset,
        text,
      });
    });
    offset += text.length;
  }
}

describe('useChatState stream delta coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('commits the first token at once and later deltas once per window', () => {
    const harness = renderChatState('session-A');
    try {
      const before = harness.renders.count;
      receiveDeltas(harness, ['Hel'], 0);
      expect(assistantText(harness.chat().messages)).toBe('Hel');
      expect(harness.renders.count).toBe(before + 1);

      // Three more deltas within one window: without coalescing, three commits.
      receiveDeltas(harness, ['lo', ' wor', 'ld'], 3);
      expect(harness.renders.count).toBe(before + 1);
      expect(assistantText(harness.chat().messages)).toBe('Hel');

      act(() => {
        vi.advanceTimersByTime(STREAM_DELTA_WINDOW_MS);
      });
      expect(harness.renders.count).toBe(before + 2);
      expect(assistantText(harness.chat().messages)).toBe('Hello world');
    } finally {
      harness.unmount();
    }
  });

  it('applies buffered deltas before a later event in the same commit', () => {
    const harness = renderChatState('session-A');
    try {
      receiveDeltas(harness, ['Hel', 'lo'], 0);
      act(() => {
        harness.chat().handleMessage({
          type: 'session_runtime_updated',
          sessionRuntime: {
            phase: 'idle',
            processState: 'alive',
            activity: 'IDLE',
            updatedAt: '2026-11-09T12:00:00.000Z',
          },
        });
      });
      expect(assistantText(harness.chat().messages)).toBe('Hello');
      expect(harness.chat().sessionRuntime.phase).toBe('idle');
    } finally {
      harness.unmount();
    }
  });

  it('applies buffered deltas when the transport disconnects', () => {
    const harness = renderChatState('session-A');
    try {
      receiveDeltas(harness, ['Hel', 'lo'], 0);
      harness.setConnected(false);
      expect(assistantText(harness.chat().messages)).toBe('Hello');
    } finally {
      harness.unmount();
    }
  });

  it('keeps deltas buffered for one session out of the next', () => {
    const harness = renderChatState('session-A');
    try {
      receiveDeltas(harness, ['Hel'], 0);
      // Buffered: the start of a second reply, which would create a message.
      act(() => {
        harness.chat().handleMessage({
          type: 'assistant_text_delta',
          messageId: 'assistant-2',
          order: 2,
          offset: 0,
          text: 'Other',
        });
      });
      expect(harness.chat().messages).toHaveLength(1);
      harness.switchSession('session-B');
      act(() => {
        vi.advanceTimersByTime(STREAM_DELTA_WINDOW_MS);
      });
      expect(harness.chat().messages).toEqual([]);
    } finally {
      harness.unmount();
    }
  });

  it('leaves no window timer behind after unmount', () => {
    const harness = renderChatState('session-A');
    receiveDeltas(harness, ['Hel', 'lo'], 0);
    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders every streamed delta within one window of its arrival', () => {
    // The documented budget allows 100 ms from receipt to the rendered text.
    // A second clock in the renderer would stack on the window and exceed it,
    // most visibly when other events flush the window early.
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const harness = renderChatState('session-A', { showReply: true });
    try {
      const arrivals: number[] = [];
      const renderedAt: number[] = [];
      let offset = 0;
      // Deltas for 1.5 s, then one more window for the last of them to render.
      for (let time = 0; time < 1500 + STREAM_DELTA_WINDOW_MS; time += 1) {
        act(() => {
          if (time < 1500 && time % 25 === 7) {
            const word = `w${String(arrivals.length).padStart(3, '0')} `;
            arrivals.push(time);
            harness.chat().handleMessage({
              type: 'assistant_text_delta',
              messageId: 'assistant-1',
              order: 1,
              offset,
              text: word,
            });
            offset += word.length;
          }
          if (time % 170 === 60) {
            harness.chat().handleMessage({ type: 'task_notification', message: `tick ${time}` });
          }
        });
        act(() => {
          vi.advanceTimersByTime(1);
        });
        const text = harness.container.textContent ?? '';
        while (
          renderedAt.length < arrivals.length &&
          text.includes(`w${String(renderedAt.length).padStart(3, '0')}`)
        ) {
          renderedAt.push(time + 1);
        }
      }
      expect(renderedAt).toHaveLength(arrivals.length);
      const latencies = renderedAt.map((at, index) => at - (arrivals[index] ?? 0));
      expect(Math.max(...latencies)).toBeLessThanOrEqual(STREAM_DELTA_WINDOW_MS);
    } finally {
      harness.unmount();
      vi.unstubAllGlobals();
    }
  });
});
