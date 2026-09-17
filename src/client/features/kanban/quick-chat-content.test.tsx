// @vitest-environment jsdom
import { type ComponentProps, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ChatInput, UseChatWebSocketReturn } from '@/client/features/chat';
import { QuickChatContent } from './quick-chat-content';

const input = vi.hoisted(() => vi.fn((_props: ComponentProps<typeof ChatInput>) => null));
const list = vi.hoisted(() => vi.fn((_props: { queuedMessageIds?: Set<string> }) => null));
vi.mock('@/client/features/chat', () => ({
  VirtualizedMessageList: list,
  useGroupedChatMessages: (messages: unknown[]) => messages,
  ChatInput: input,
  PermissionPrompt: () => null,
  QuestionPrompt: () => null,
}));

describe('QuickChatContent composer and queue controls', () => {
  it('connects queue controls and composer attachments to shared chat state', () => {
    const removeQueuedMessage = vi.fn();
    const attachments = [
      {
        id: 'attachment-1',
        name: 'notes.txt',
        type: 'text/plain',
        size: 5,
        data: 'notes',
        contentType: 'text' as const,
      },
    ];
    const setInputAttachments = vi.fn();
    const chatState = {
      inputAttachments: attachments,
      setInputAttachments,
      messages: [],
      queuedMessages: [{ id: 'queued-1' }],
      pendingMessages: new Map(),
      pendingRequest: { type: 'none' },
      sessionStatus: { phase: 'running' },
      removeQueuedMessage,
    } as unknown as UseChatWebSocketReturn;
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = () =>
      flushSync(() =>
        root.render(
          <QuickChatContent
            workspaceId="workspace-1"
            chatState={chatState}
            viewportRef={createRef()}
            onScroll={vi.fn()}
            isNearBottom
            scrollToBottom={vi.fn()}
          />
        )
      );
    try {
      render();
      expect(list.mock.lastCall?.[0]).toMatchObject({
        queuedMessageIds: new Set(['queued-1']),
        onRemoveQueuedMessage: removeQueuedMessage,
      });
      expect(input.mock.lastCall?.[0].attachments).toBe(attachments);
      input.mock.lastCall?.[0].onAttachmentsChange?.([]);
      expect(setInputAttachments).toHaveBeenCalledWith([]);
      chatState.inputAttachments = [];
      chatState.queuedMessages = [];
      render();
      expect(list.mock.lastCall?.[0]?.queuedMessageIds).toEqual(new Set());
      expect(input.mock.lastCall?.[0].attachments).toEqual([]);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
