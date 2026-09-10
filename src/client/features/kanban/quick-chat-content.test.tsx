// @vitest-environment jsdom
import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { UseChatWebSocketReturn } from '@/client/features/chat';
import { QuickChatContent } from './quick-chat-content';

const list = vi.hoisted(() => vi.fn((_props: unknown) => null));
vi.mock('@/client/features/chat', () => ({
  VirtualizedMessageList: list,
  useGroupedChatMessages: (messages: unknown[]) => messages,
  ChatInput: () => null,
  PermissionPrompt: () => null,
  QuestionPrompt: () => null,
}));

describe('QuickChatContent queue controls', () => {
  it('passes the current queue and cancellation action to the message list', () => {
    const removeQueuedMessage = vi.fn();
    const chatState = {
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
      chatState.queuedMessages = [];
      render();
      expect(list.mock.lastCall?.[0]).toMatchObject({ queuedMessageIds: new Set() });
    } finally {
      flushSync(() => root.unmount());
    }
  });
});
