// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { MessageState } from '@/lib/chat-protocol';
import { type UseChatStateReturn, useChatState } from './use-chat-state';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

interface ChatStateHarnessProps {
  dbSessionId: string | null;
  send: (message: unknown) => boolean;
  chatRef: { current: UseChatStateReturn | null };
}

function ChatStateHarness({ dbSessionId, send, chatRef }: ChatStateHarnessProps) {
  chatRef.current = useChatState({ dbSessionId, send, connected: true });
  return null;
}

function renderChatState(initialSessionId: string | null, send = vi.fn(() => true)) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const chatRef = { current: null as UseChatStateReturn | null };

  const render = (dbSessionId: string | null) => {
    root.render(createElement(ChatStateHarness, { dbSessionId, send, chatRef }));
  };

  flushSync(() => {
    render(initialSessionId);
  });

  return {
    chatRef,
    send,
    rerenderSession: (dbSessionId: string | null) => {
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
  const lastCall = send.mock.calls.at(-1);
  const message = lastCall?.[0];
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
    vi.restoreAllMocks();
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

  it('warns when input attachments cannot be autosaved', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    flushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();

    expect(harness.chatRef.current?.inputAttachments).toEqual([createAttachment()]);
    expect(sessionStorage.getItem('chat-attachments-session-A')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      'Attachments were not autosaved',
      expect.objectContaining({
        description:
          'They are still in this composer, but may be lost if you reload or switch sessions.',
      })
    );

    harness.cleanup();
  });

  it('warns when sent input attachments cannot be cleared from storage', async () => {
    const harness = renderChatState('session-A');
    await flushEffects();

    flushSync(() => {
      harness.chatRef.current?.setInputAttachments([createAttachment()]);
    });

    await flushEffects();
    const removeItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      if (key === 'chat-attachments-session-A') {
        throw new DOMException('Storage unavailable', 'InvalidStateError');
      }
      return removeItem.call(this, key);
    });

    flushSync(() => {
      harness.chatRef.current?.sendMessage('send with attachment');
    });

    await flushEffects();

    expect(harness.chatRef.current?.inputAttachments).toEqual([]);
    expect(sessionStorage.getItem('chat-attachments-session-A')).toContain('secret.txt');
    expect(toast.error).toHaveBeenCalledWith(
      'Saved attachments could not be cleared',
      expect.objectContaining({
        description: 'Previously saved attachments may reappear after a reload or session switch.',
      })
    );

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

  it('does not recover rejected message content without a captured source session', async () => {
    const harness = renderChatState(null);
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

    expect(harness.chatRef.current?.inputDraft).toBe('');
    expect(harness.chatRef.current?.inputAttachments).toEqual([]);
    expect(sessionStorage.getItem('chat-draft-null')).toBeNull();
    expect(sessionStorage.getItem('chat-attachments-null')).toBeNull();

    harness.cleanup();
  });
});
