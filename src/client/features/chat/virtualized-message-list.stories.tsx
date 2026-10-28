import type { Meta, StoryObj } from '@storybook/react';
import { useRef } from 'react';
import type { ChatMessage } from '@/lib/chat-protocol';
import {
  createAssistantMessage,
  createThinkingMessage,
  createUserMessage,
} from '@/lib/claude-fixtures';
import { useGroupedChatMessages } from './use-grouped-chat-messages';
import { VirtualizedMessageList } from './virtualized-message-list';

const meta: Meta<typeof VirtualizedMessageList> = {
  title: 'Chat/VirtualizedMessageList',
  component: VirtualizedMessageList,
  decorators: [
    (Story) => (
      <div className="h-96 bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    messages: [],
    running: false,
    startingSession: false,
    loadingSession: true,
    scrollContainerRef: { current: null },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceCreation: Story = {
  args: {
    initBanner: {
      kind: 'info',
      message: 'Creating worktree...',
      showRetry: false,
      showPlay: false,
      showDismiss: false,
    },
  },
};

export const SessionLoading: Story = {};

export const BackgroundPreview: Story = {
  args: {
    running: true,
    loadingSession: false,
    work: {
      promptInFlight: false,
      backgroundTasks: [
        { id: 'preview', name: 'pnpm storybook --port 62770', kind: 'shell' as const },
      ],
      runningSubagents: 0,
      activeGoals: 0,
    },
  },
};

export const BackgroundAfterFailedTurn: Story = {
  args: { ...BackgroundPreview.args, running: false },
};

export const PromptWithBackgroundWork: Story = {
  args: {
    ...BackgroundPreview.args,
    latestThinking: 'Checking the preview',
    work: {
      promptInFlight: true,
      backgroundTasks: [
        { id: 'preview', name: 'pnpm storybook --port 62770', kind: 'shell' as const },
        { id: 'tests', name: 'pnpm test', kind: 'shell' as const },
      ],
      runningSubagents: 1,
      activeGoals: 2,
    },
  },
};

const historyMessages: ChatMessage[] = [
  createUserMessage('What changed?', 0),
  {
    id: 'history-thinking',
    source: 'agent',
    timestamp: '2026-10-28T00:00:00.000Z',
    order: 1,
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
    },
  },
  createThinkingMessage('Checking the implementation.', 2),
  createAssistantMessage('Past sessions show the conversation without thinking boxes.', 3),
];

function HistoryPreview({ running = false }: { running?: boolean }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messages = useGroupedChatMessages(historyMessages);
  return (
    <div ref={scrollContainerRef} className="h-full overflow-auto">
      <VirtualizedMessageList
        messages={messages}
        running={running}
        startingSession={false}
        loadingSession={false}
        latestThinking="Checking the next step"
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
}

export const PastSession: Story = {
  render: () => <HistoryPreview />,
};

export const LiveActivity: Story = {
  render: () => <HistoryPreview running />,
};
