// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyTokenStats } from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { ChatInput } from './chat-input';

const mocks = vi.hoisted(() => ({
  fileSelect: vi.fn(async () => undefined),
  callbacks: [] as unknown[],
}));

vi.mock('@/client/features/composer', () => ({
  FileMentionPalette: () => null,
  SlashCommandPalette: () => null,
  usePasteDropHandler: () => ({}),
  useSlashCommands: () => ({}),
}));
vi.mock('./hooks/use-file-mentions', () => ({ useFileMentions: () => ({}) }));
vi.mock('./hooks/use-textarea-resize', () => ({ useTextareaResize: () => undefined }));
vi.mock('./hooks/use-chat-input-actions', () => ({
  useChatInputActions: () => ({ handleFileSelect: mocks.fileSelect }),
}));
vi.mock('./components/input-controls', () => ({
  AttachmentSection: () => null,
  RightControls: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
  LeftControls: ({ onFileSelect }: { onFileSelect: unknown }) => {
    mocks.callbacks.push(onFileSelect);
    return null;
  },
}));

vi.mock('@/client/features/chat/usage-stats/provider-usage-control', () => ({
  ProviderUsageControl: ({ onCompact }: { onCompact: () => void }) =>
    createElement('button', { onClick: onCompact }, 'Compact'),
}));

describe('ChatInput file controls', () => {
  it('preserves the file-selection callback when unrelated input props change', () => {
    mocks.callbacks.length = 0;
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSend = vi.fn();
    try {
      flushSync(() => root.render(createElement(ChatInput, { onSend, placeholder: 'First' })));
      flushSync(() => root.render(createElement(ChatInput, { onSend, placeholder: 'Second' })));
      expect(mocks.callbacks).toHaveLength(2);
      expect(mocks.callbacks[1]).toBe(mocks.callbacks[0]);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

it('sends /compact through the existing pipeline without clearing the draft or attachments', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onSend = vi.fn();
  const onChange = vi.fn();
  const onAttachmentsChange = vi.fn();
  const capabilities: ChatBarCapabilities = {
    provider: 'CLAUDE',
    model: { enabled: false, options: [] },
    reasoning: { enabled: false, options: [] },
    thinking: { enabled: false },
    planMode: { enabled: false },
    attachments: { enabled: false, kinds: [] },
    slashCommands: { enabled: false },
    usageStats: { enabled: true, contextWindow: true },
    rewind: { enabled: false },
  };
  try {
    flushSync(() =>
      root.render(
        createElement(ChatInput, {
          onSend,
          onChange,
          onAttachmentsChange,
          capabilities,
          value: 'Keep my draft',
          tokenStats: createEmptyTokenStats(),
          attachments: [
            {
              id: 'image-1',
              name: 'image.png',
              type: 'image/png',
              data: 'abc',
              size: 3,
              contentType: 'image',
            },
          ],
        })
      )
    );
    const textarea = container.querySelector('textarea');
    if (!textarea) {
      throw new Error('Missing composer');
    }
    textarea.value = 'Keep my draft';
    const button = container.querySelector('button');
    if (!button) {
      throw new Error('Missing Compact button');
    }
    flushSync(() => button.click());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('/compact');
    expect(textarea.value).toBe('Keep my draft');
    expect(onChange).not.toHaveBeenCalled();
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  } finally {
    flushSync(() => root.unmount());
  }
});
