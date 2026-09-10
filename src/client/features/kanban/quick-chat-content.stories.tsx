import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { fn } from 'storybook/test';
import type { UseChatWebSocketReturn } from '@/client/features/chat';
import { DEFAULT_CHAT_SETTINGS, type QueuedMessage } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { QuickChatContent } from './quick-chat-content';

const meta: Meta<typeof QuickChatContent> = {
  title: 'Kanban/QuickChatContent',
  component: QuickChatContent,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const QueuedMessageCancellation: Story = {
  render: () => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([
      {
        id: 'queued-1',
        text: 'Then add tests for the login flow',
        timestamp: '2026-09-10T12:00:00.000Z',
        settings: DEFAULT_CHAT_SETTINGS,
      },
    ]);
    const chatState = {
      messages: queuedMessages.map((message, order) => ({
        ...message,
        order,
        source: 'user' as const,
      })),
      queuedMessages,
      pendingMessages: new Map(),
      pendingRequest: { type: 'none' },
      sessionStatus: { phase: 'running' },
      connected: true,
      inputDraft: '',
      chatSettings: DEFAULT_CHAT_SETTINGS,
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      slashCommands: [],
      slashCommandsLoaded: true,
      acpConfigOptions: null,
      inputRef,
      messagesEndRef,
      sendMessage: fn(),
      stopChat: fn(),
      updateSettings: fn(),
      setInputDraft: fn(),
      setConfigOption: fn(),
      removeQueuedMessage: (id: string) =>
        setQueuedMessages((messages) => messages.filter((message) => message.id !== id)),
    } as unknown as UseChatWebSocketReturn;
    return (
      <div className="h-[480px] w-[400px] border">
        <QuickChatContent
          workspaceId="quick-chat-story"
          chatState={chatState}
          viewportRef={viewportRef}
          onScroll={fn()}
          isNearBottom
          scrollToBottom={fn()}
        />
      </div>
    );
  },
};
