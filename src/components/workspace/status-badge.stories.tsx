import type { Meta, StoryObj } from '@storybook/react';
import { StatusBadge } from './status-badge';

const meta = {
  title: 'Workspace/StatusBadge',
  component: StatusBadge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const New: Story = {
  args: {
    status: 'NEW',
  },
};

export const Provisioning: Story = {
  args: {
    status: 'PROVISIONING',
  },
};

export const Ready: Story = {
  name: 'Ready (renders null)',
  args: {
    status: 'READY',
  },
};

export const Archived: Story = {
  name: 'Archived (renders null)',
  args: {
    status: 'ARCHIVED',
  },
};

export const Failed: Story = {
  args: {
    status: 'FAILED',
  },
};

export const FailedWithError: Story = {
  args: {
    status: 'FAILED',
    errorMessage: 'Git worktree creation failed: branch already exists',
  },
};

export const AllStates: Story = {
  decorators: [
    () => (
      <div className="flex flex-col gap-4 items-start">
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">New:</span>
          <StatusBadge status="NEW" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Provisioning:</span>
          <StatusBadge status="PROVISIONING" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Ready:</span>
          <span className="text-xs text-muted-foreground">(renders null)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Archived:</span>
          <span className="text-xs text-muted-foreground">(renders null)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Failed:</span>
          <StatusBadge status="FAILED" errorMessage="Example error message" />
        </div>
      </div>
    ),
  ],
  args: {
    status: 'NEW',
  },
};
