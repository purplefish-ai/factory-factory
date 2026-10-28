import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
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

/** A partial bulk failure offers recovery for just its locked subset. */
export const PendingLockedSubset: Story = {
  args: { workspaceCount: 2, isPending: true },
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(dialog.getByText(/the 2 affected workspaces/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Retry$/ })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Remove Lock and Archive' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  },
};
