import type { Meta, StoryObj } from '@storybook/react';
import { InitStatusBadge } from './init-status-badge';

const meta = {
  title: 'Workspace/InitStatusBadge',
  component: InitStatusBadge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof InitStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: {
    status: 'PENDING',
  },
};

export const Initializing: Story = {
  args: {
    status: 'INITIALIZING',
  },
};

export const Ready: Story = {
  name: 'Ready (renders null)',
  args: {
    status: 'READY',
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
          <span className="w-24 text-sm text-muted-foreground">Pending:</span>
          <InitStatusBadge status="PENDING" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Initializing:</span>
          <InitStatusBadge status="INITIALIZING" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Ready:</span>
          <span className="text-xs text-muted-foreground">(renders null)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Failed:</span>
          <InitStatusBadge status="FAILED" errorMessage="Example error message" />
        </div>
      </div>
    ),
  ],
  args: {
    status: 'PENDING',
  },
};
