// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
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
  RightControls: () => null,
  LeftControls: ({ onFileSelect }: { onFileSelect: unknown }) => {
    mocks.callbacks.push(onFileSelect);
    return null;
  },
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
