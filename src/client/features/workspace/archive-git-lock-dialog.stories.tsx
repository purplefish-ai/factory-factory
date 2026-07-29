import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ArchiveGitLockDialog } from './archive-git-lock-dialog';

const meta = {
  title: 'Workspace/ArchiveGitLockDialog',
  component: ArchiveGitLockDialog,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    open: true,
    onOpenChange: fn(),
    onRetry: fn(),
    onRemoveLockAndArchive: fn(),
  },
} satisfies Meta<typeof ArchiveGitLockDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleWorkspace: Story = {};

export const MultipleWorkspaces: Story = {
  args: {
    workspaceCount: 3,
  },
};
