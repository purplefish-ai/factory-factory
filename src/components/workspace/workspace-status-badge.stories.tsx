import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceStatusBadge } from './workspace-status-badge';

const meta = {
  title: 'Workspace/WorkspaceStatusBadge',
  component: WorkspaceStatusBadge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof WorkspaceStatusBadge>;

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

export const Archived: Story = {
  name: 'Archived (renders null)',
  args: {
    status: 'ARCHIVED',
  },
};

export const AllStates: Story = {
  decorators: [
    () => (
      <div className="flex flex-col gap-4 items-start">
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">New:</span>
          <WorkspaceStatusBadge status="NEW" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Provisioning:</span>
          <WorkspaceStatusBadge status="PROVISIONING" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Ready:</span>
          <span className="text-xs text-muted-foreground">(renders null)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Failed:</span>
          <WorkspaceStatusBadge status="FAILED" errorMessage="Example error message" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-sm text-muted-foreground">Archived:</span>
          <span className="text-xs text-muted-foreground">(renders null)</span>
        </div>
      </div>
    ),
  ],
  args: {
    status: 'NEW',
  },
};
