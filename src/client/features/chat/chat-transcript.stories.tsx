import type { Meta, StoryObj } from '@storybook/react';
import { type ComponentProps } from 'react';
import type { ChatMessage } from '@/lib/chat-protocol';
import {
  createAssistantMessage,
  createThinkingMessage,
  createUserMessage,
} from '@/lib/claude-fixtures';
import { ChatTranscript } from './chat-transcript';
import { useGroupedChatMessages } from './use-grouped-chat-messages';

const meta: Meta<typeof ChatTranscript> = {
  title: 'Chat/ChatTranscript',
  component: ChatTranscript,
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
    scroll: {
      identity: 'story',
      active: true,
      ready: true,
      initialIntent: 'following',
      initialPosition: null,
    },
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

const startupMessage = createUserMessage('Please fix the failing tests and explain what changed.');

function StartupPreview(props: ComponentProps<typeof ChatTranscript>) {
  return (
    <div className="h-full overflow-auto">
      <ChatTranscript
        {...props}
        scroll={{
          identity: 'story',
          active: true,
          ready: true,
          initialIntent: 'following',
          initialPosition: null,
        }}
      />
    </div>
  );
}

export const QueuedDuringInitScript: Story = {
  render: (args) => <StartupPreview {...args} />,
  args: {
    messages: [startupMessage],
    queuedMessageIds: new Set([startupMessage.id]),
    onRemoveQueuedMessage: () => undefined,
    initBanner: {
      kind: 'info',
      message: 'Running init script...',
      showRetry: false,
      showPlay: false,
      showDismiss: false,
    },
  },
};

export const QueuedDuringSessionLoading: Story = {
  ...QueuedDuringInitScript,
  args: { ...QueuedDuringInitScript.args, initBanner: null },
};

export const QueuedDuringAgentStartup: Story = {
  ...QueuedDuringSessionLoading,
  args: {
    ...QueuedDuringSessionLoading.args,
    loadingSession: false,
    startingSession: true,
  },
};

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

export const MultipleBackgroundProcesses: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Commands start collapsed. Click the process count to expand or collapse the list. Screen readers receive count updates separately from the control and commands.',
      },
    },
  },
  args: {
    ...BackgroundPreview.args,
    work: {
      promptInFlight: false,
      backgroundTasks: [
        { id: 'preview', name: 'pnpm storybook --port 62770', kind: 'shell' as const },
        {
          id: 'tests',
          name: 'pnpm test src/client/features/chat --maxWorkers=1',
          kind: 'shell' as const,
        },
        { id: 'dev', name: 'pnpm dev', kind: 'shell' as const },
      ],
      runningSubagents: 0,
      activeGoals: 0,
    },
  },
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
  const messages = useGroupedChatMessages(historyMessages);
  return (
    <div className="h-full overflow-auto">
      <ChatTranscript
        messages={messages}
        running={running}
        startingSession={false}
        loadingSession={false}
        latestThinking="Checking the next step"
        scroll={{
          identity: 'story',
          active: true,
          ready: true,
          initialIntent: 'following',
          initialPosition: null,
        }}
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
