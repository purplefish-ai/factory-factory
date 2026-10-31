import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { InitStatusBanner } from './workspace-init-status-banner';

const meta = {
  title: 'Workspaces/Setup Recovery',
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
export const RetryingSetup: Story = { args: { retryPending: true } };
