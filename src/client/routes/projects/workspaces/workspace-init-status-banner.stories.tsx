import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { InitStatusBanner } from './workspace-init-status-banner';

const meta = {
  title: 'Workspace/WorkspaceInitStatusBanner',
  component: InitStatusBanner,
  args: {
    banner: {
      kind: 'error',
      message:
        'Git could not create the worktree. Your task instructions and attachments are saved in this workspace.',
      showRetry: true,
      showPlay: false,
      showDismiss: false,
    },
    retryPending: false,
    retryAvailability: { status: 'AVAILABLE' },
    onRetry: fn(),
    onPlay: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InitStatusBanner>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BeforeFirstSession: Story = {};
export const RetryingSetup: Story = {
  args: { retryPending: true },
  parameters: {
    docs: {
      description: {
        story: 'Setup retry is pending: the action shows a spinner and stays disabled.',
      },
    },
  },
};

export const EventInitialPending: Story = {
  args: {
    retryAvailability: {
      status: 'BLOCKED',
      reason: 'INITIAL_PENDING',
      explanation:
        'The event initial task has not been sent yet. Setup retry is unavailable while it owns initialization.',
    },
  },
};
export const AuthorityUnavailable: Story = { args: { retryAvailability: undefined } };
