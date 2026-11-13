import type { Meta, StoryObj } from '@storybook/react';
import type { ChatTranscript } from './chat-transcript';
import { StartupPreview, chatTranscriptMeta } from './chat-transcript.story-fixtures';

const meta: Meta<typeof ChatTranscript> = {
  ...chatTranscriptMeta,
  title: 'Chat/Transcript/ChatTranscript',
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceCreation: Story = {
  args: {
    history: { status: 'idle', enabled: false, loadOlder: () => undefined },
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

export const InlineTasks: Story = {
  render: (args) => <StartupPreview {...args} />,
  args: {
    loadingSession: false,
    acpPlan: {
      updatedAt: '2026-10-30T00:00:00Z',
      entries: [
        { content: 'Read design, notes, parser code', status: 'completed', priority: 'medium' },
        { content: 'Implement drawing titles', status: 'in_progress', priority: 'high' },
        { content: 'Truth file and title measurement', status: 'pending', priority: 'medium' },
        { content: 'Ship titles PR', status: 'pending', priority: 'low' },
      ],
    },
  },
};

export const CompletedTasks: Story = {
  ...InlineTasks,
  args: {
    ...InlineTasks.args,
    acpPlan: {
      updatedAt: '2026-10-30T00:00:00Z',
      entries: [{ content: 'Ship titles PR', status: 'completed', priority: 'medium' }],
    },
  },
};

export const LongTaskLabels: Story = {
  ...InlineTasks,
  args: {
    ...InlineTasks.args,
    acpPlan: {
      updatedAt: '2026-10-30T00:00:00Z',
      entries: [
        {
          content:
            'Verify deeply nested file paths and long task labels wrap within the conversation: src/client/features/chat/agent-activity/tool-renderers/tool-input-renderer.tsx',
          status: 'in_progress',
          priority: 'medium',
        },
      ],
    },
  },
};

export const SubagentTimelineRecovery: Story = {
  render: (args) => <StartupPreview {...args} />,
  args: {
    loadingSession: false,
    subagentTimelineError: {
      message: 'Some subagent activity could not be loaded.',
      onRetry: () => undefined,
    },
  },
};

export const SubagentTimelineRecoveryWithTasks: Story = {
  ...SubagentTimelineRecovery,
  args: {
    ...SubagentTimelineRecovery.args,
    acpPlan: {
      entries: [{ content: 'Verify chat activity', status: 'in_progress', priority: 'high' }],
      updatedAt: '2026-10-30T12:00:00Z',
    },
  },
};
