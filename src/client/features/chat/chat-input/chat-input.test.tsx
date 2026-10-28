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
vi.mock('./components/input-controls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./components/input-controls')>()),
  AttachmentSection: () => null,
  LeftControls: ({ onFileSelect }: { onFileSelect: unknown }) => {
    mocks.callbacks.push(onFileSelect);
    return null;
  },
}));

vi.mock('@/client/features/chat/usage-stats/provider-usage-control', () => ({
  ProviderUsageControl: ({ onCompact }: { onCompact?: () => void }) =>
    createElement('button', { onClick: onCompact, disabled: !onCompact }, 'Compact'),
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

it.each([
  { promptInFlight: false, label: 'Send message' },
  { promptInFlight: true, label: 'Queue message' },
])(
  'keeps queue wording separate from background work ($promptInFlight)',
  ({ promptInFlight, label }) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(<ChatInput onSend={vi.fn()} running promptInFlight={promptInFlight} />)
      );
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
      expect(container.querySelector('[aria-label="Stop agent"]')).not.toBeNull();
    } finally {
      flushSync(() => root.unmount());
    }
  }
);

it.each([true, false])(
  'preserves composer input with a dedicated compact callback: %s',
  (hasCompactCallback) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSend = vi.fn();
    const onCompact = vi.fn();
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
            onCompact: hasCompactCallback ? onCompact : undefined,
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
      expect(button.disabled).toBe(!hasCompactCallback);
      expect(onCompact).toHaveBeenCalledTimes(hasCompactCallback ? 1 : 0);
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea.value).toBe('Keep my draft');
      expect(onChange).not.toHaveBeenCalled();
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    } finally {
      flushSync(() => root.unmount());
    }
  }
);
