// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { MessageState } from '@/lib/chat-protocol';
import { type UseChatStateReturn, useChatState } from './use-chat-state';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

interface ChatStateHarnessProps {
  dbSessionId: string;
  send: (message: unknown) => boolean;
  chatRef: { current: UseChatStateReturn | null };
}

function ChatStateHarness({ dbSessionId, send, chatRef }: ChatStateHarnessProps) {
  chatRef.current = useChatState({ dbSessionId, send, connected: true });
  return null;
}

function renderChatState(initialSessionId: string, send = vi.fn(() => true)) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const chatRef = { current: null as UseChatStateReturn | null };

  const render = (dbSessionId: string) => {
    root.render(createElement(ChatStateHarness, { dbSessionId, send, chatRef }));
  };

  flushSync(() => {
    render(initialSessionId);
  });

  return {
    chatRef,
    send,
    rerenderSession: (dbSessionId: string) => {
      render(dbSessionId);
    },
    cleanup: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushDraftDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function createAttachment(): MessageAttachment {
  return {
    id: 'att-1',
    name: 'secret.txt',
    type: 'text/plain',
    size: 11,
    data: 'secret data',
    contentType: 'text',
  };
}

function getSentMessageId(send: ReturnType<typeof vi.fn>): string {
  const message = send.mock.calls[0]?.[0];
  if (typeof message !== 'object' || message === null || !('id' in message)) {
    throw new Error('Expected queued message with an id');
  }
  const id = message.id;
  if (typeof id !== 'string') {
    throw new Error('Expected string message id');
  }
  return id;
}

describe('useChatState rejected message recovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('restores rejected message content for the same session', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();

    flushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    flushSync(() => {
      harness.chatRef.current?.sendMessage('sensitive data');
    });

    const messageId = getSentMessageId(harness.send);
    flushSync(() => {
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: messageId,
          newState: MessageState.REJECTED,
          errorMessage: 'Rejected',
        },
      });
    });

    await flushEffects();
    await flushDraftDebounce();

    expect(harness.chatRef.current?.inputDraft).toBe('sensitive data');
    expect(harness.chatRef.current?.inputAttachments).toEqual([createAttachment()]);
    expect(sessionStorage.getItem('chat-draft-session-A')).toBe('sensitive data');
    expect(sessionStorage.getItem('chat-attachments-session-A')).toContain('secret.txt');

    harness.cleanup();
  });

  it('does not persist rejected message content into a newly selected session', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();

    flushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    flushSync(() => {
      harness.chatRef.current?.sendMessage('sensitive data');
    });

    const messageId = getSentMessageId(harness.send);
    flushSync(() => {
      harness.chatRef.current?.dispatch({
        type: 'MESSAGE_STATE_CHANGED',
        payload: {
          id: messageId,
          newState: MessageState.REJECTED,
          errorMessage: 'Rejected',
        },
      });
      harness.rerenderSession('session-B');
    });

    await flushEffects();
    await flushDraftDebounce();

    expect(harness.chatRef.current?.inputDraft).not.toBe('sensitive data');
    expect(harness.chatRef.current?.inputAttachments).toEqual([]);
    expect(sessionStorage.getItem('chat-draft-session-B') ?? '').not.toContain('sensitive data');
    expect(sessionStorage.getItem('chat-attachments-session-B') ?? '').not.toContain('secret.txt');

    harness.cleanup();
  });
});
