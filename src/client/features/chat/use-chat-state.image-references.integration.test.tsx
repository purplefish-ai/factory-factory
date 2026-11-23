// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type UseChatStateReturn, useChatState } from '@/client/features/chat/use-chat-state';
import { attachmentImageSrc } from '@/client/lib/chat-images';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { actFlushSync } from '@/test-utils/react-act';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250]);
const base64 = Buffer.from(bytes).toString('base64');
const ref = { id: 'd'.repeat(64), size: bytes.length };

function image(id: string, inline: boolean): MessageAttachment {
  return {
    id,
    name: 'shot.png',
    type: 'image/png',
    size: bytes.length,
    data: inline ? base64 : '',
    contentType: 'image',
    ...(inline ? {} : { ref }),
  };
}

function Harness(props: {
  sessionId: string;
  send: (message: unknown) => boolean;
  chatRef: { current: UseChatStateReturn | null };
}) {
  props.chatRef.current = useChatState({
    dbSessionId: props.sessionId,
    send: props.send,
    connected: true,
  });
  return null;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderChatState() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const chatRef = { current: null as UseChatStateReturn | null };
  const send = vi.fn((_message: unknown) => true);
  const render = (sessionId: string) =>
    actFlushSync(() => root.render(createElement(Harness, { sessionId, send, chatRef })));
  render('session-A');
  await flushEffects();
  return {
    selectSession: render,
    chat: () => {
      if (!chatRef.current) {
        throw new Error('Chat state is not rendered');
      }
      return chatRef.current;
    },
    send,
    cleanup: () => {
      actFlushSync(() => root.unmount());
      container.remove();
    },
  };
}

describe('useChatState image references', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('shows the echo of an image it sent from its own copy', async () => {
    const harness = await renderChatState();
    try {
      actFlushSync(() => harness.chat().setInputAttachments([image('sent-1', true)]));
      actFlushSync(() => harness.chat().sendMessage('look'));
      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'queue_message', attachments: [image('sent-1', true)] })
      );
      expect(attachmentImageSrc(image('sent-1', false))).toBe(`data:image/png;base64,${base64}`);
    } finally {
      harness.cleanup();
    }
  });

  it('sends a referenced image again with its bytes restored', async () => {
    const fetchImage = vi.fn(async (_url: string) => new Response(bytes));
    vi.stubGlobal('fetch', fetchImage);
    const harness = await renderChatState();
    try {
      actFlushSync(() =>
        harness.chat().sendMessage('again', {
          preserveInput: true,
          attachments: [image('history-image-1', false)],
        })
      );
      await act(flushEffects);
      expect(fetchImage).toHaveBeenCalledWith(`/api/chat-images/${ref.id}`);
      const sent = harness.send.mock.calls.at(-1)?.[0];
      expect(sent).toMatchObject({ type: 'queue_message', text: 'again' });
      expect(sent).toHaveProperty('attachments', [
        {
          id: 'history-image-1',
          name: 'shot.png',
          type: 'image/png',
          size: bytes.length,
          data: base64,
          contentType: 'image',
        },
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it('reports an image that is gone instead of sending without it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    );
    const harness = await renderChatState();
    try {
      actFlushSync(() =>
        harness.chat().sendMessage('again', {
          preserveInput: true,
          // Not sent from this tab, so only the server has its bytes.
          attachments: [image('history-image-2', false)],
        })
      );
      await act(flushEffects);
      expect(harness.send).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Couldn't send the message", {
        description: 'shot.png is no longer available. Attach it again.',
      });
    } finally {
      harness.cleanup();
    }
  });

  it('sends a referenced image once, however often it is retried while it downloads', async () => {
    const pending: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)))
    );
    const harness = await renderChatState();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        actFlushSync(() =>
          harness.chat().sendMessage('again', {
            preserveInput: true,
            attachments: [image('history-image-3', false)],
          })
        );
      }
      for (const respond of pending) {
        respond(new Response(bytes));
      }
      await act(flushEffects);
      expect(harness.send).toHaveBeenCalledTimes(1);
    } finally {
      harness.cleanup();
    }
  });

  it('drops a restored send when another session was selected while it downloaded', async () => {
    let respond: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)))
    );
    const harness = await renderChatState();
    try {
      actFlushSync(() =>
        harness.chat().sendMessage('again', { attachments: [image('history-image-4', false)] })
      );
      harness.selectSession('session-B');
      actFlushSync(() => harness.chat().setInputDraft('draft for B'));
      respond(new Response(bytes));
      await act(flushEffects);
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.chat().inputDraft).toBe('draft for B');
    } finally {
      harness.cleanup();
    }
  });
});
