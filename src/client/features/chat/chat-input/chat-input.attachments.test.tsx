// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { ChatInput } from './chat-input';

const clipboard = vi.hoisted(() => ({
  hasImage: false,
  text: null as string | null,
  pendingImages: [] as Array<(attachments: MessageAttachment[]) => void>,
}));

vi.mock('@/client/lib/paste-utils', () => ({
  clipboardEventHasImageItem: () => clipboard.hasImage,
  clipboardEventHasConfirmedImageType: () => clipboard.hasImage,
  getClipboardText: () => clipboard.text,
  isLargeText: () => true,
  textToAttachment: (text: string): MessageAttachment => ({
    id: `text-${text}`,
    name: 'Pasted text',
    type: 'text/plain',
    size: text.length,
    data: text,
    contentType: 'text',
  }),
  getClipboardImages: () =>
    new Promise<{ attachments: MessageAttachment[]; errors: string[] }>((resolve) => {
      clipboard.pendingImages.push((attachments) => resolve({ attachments, errors: [] }));
    }),
}));

function image(id: string): MessageAttachment {
  return { id, name: `${id}.png`, type: 'image/png', size: 3, data: 'abc', contentType: 'image' };
}

let latestAttachments: MessageAttachment[] = [];
let setHostAttachments: React.Dispatch<React.SetStateAction<MessageAttachment[]>> = () => {
  throw new Error('Host not rendered');
};

// Mirrors the workspace composer: attachments live in the parent's state.
function Host() {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  latestAttachments = attachments;
  setHostAttachments = setAttachments;
  return (
    <ChatInput onSend={vi.fn()} attachments={attachments} onAttachmentsChange={setAttachments} />
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  clipboard.hasImage = false;
  clipboard.text = null;
  clipboard.pendingImages.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

async function renderHost() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [] });
  latestAttachments = [];

  await act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <trpc.Provider client={client} queryClient={queryClient}>
          <Host />
        </trpc.Provider>
      </QueryClientProvider>
    )
  );

  return {
    paste: async () => {
      const textarea = container.querySelector('textarea');
      if (!textarea) {
        throw new Error('Missing composer textarea');
      }
      await act(() => {
        textarea.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
      });
    },
    cleanup: async () => {
      await act(() => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
}

describe('ChatInput controlled attachments', () => {
  it('keeps every pasted attachment when an image finishes converting after a later paste', async () => {
    const host = await renderHost();
    try {
      // A screenshot paste starts converting asynchronously...
      clipboard.hasImage = true;
      await host.paste();
      expect(clipboard.pendingImages).toHaveLength(1);

      // ...while the user pastes a large log, which attaches immediately.
      clipboard.hasImage = false;
      clipboard.text = 'stack trace';
      await host.paste();
      expect(latestAttachments.map((attachment) => attachment.id)).toEqual(['text-stack trace']);

      // The screenshot conversion finishes afterwards.
      await act(async () => {
        clipboard.pendingImages[0]?.([image('screenshot')]);
        await Promise.resolve();
      });

      expect(latestAttachments.map((attachment) => attachment.id)).toEqual([
        'text-stack trace',
        'screenshot',
      ]);
    } finally {
      await host.cleanup();
    }
  });

  it('keeps a parent attachment write that lands before the composer re-renders', async () => {
    const host = await renderHost();
    try {
      clipboard.hasImage = true;
      await host.paste();
      expect(clipboard.pendingImages).toHaveLength(1);

      // The workspace drop zone appends through the parent's setter, and the
      // paste conversion finishes before React renders that write.
      await act(async () => {
        setHostAttachments((previous) => [...previous, image('dropped')]);
        clipboard.pendingImages[0]?.([image('screenshot')]);
        await Promise.resolve();
      });

      expect(latestAttachments.map((attachment) => attachment.id)).toEqual([
        'dropped',
        'screenshot',
      ]);
    } finally {
      await host.cleanup();
    }
  });
});
