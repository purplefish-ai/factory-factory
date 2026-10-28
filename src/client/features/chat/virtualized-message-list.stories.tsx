import type { Meta, StoryObj } from '@storybook/react';
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
