import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { StatusCallout } from '@/client/components/status-callout';
import { ConfirmDialog } from './confirm-dialog';

const meta = {
  title: 'UI/ConfirmDialog',
  component: ConfirmDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    title: 'Delete agent?',
    description: 'The agent and its run history are removed. This cannot be undone.',
    confirmText: 'Delete',
    pendingText: 'Deleting…',
    variant: 'destructive',
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args }) => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole('button', { name: 'Delete' }));
    await expect(args.onConfirm).toHaveBeenCalledTimes(1);
    // Confirming leaves closing to the action's success handler.
    await expect(args.onOpenChange).not.toHaveBeenCalled();
  },
};

/** While the action runs the label stays beside the spinner and Escape is ignored. */
export const Pending: Story = {
  args: { isPending: true },
  play: async ({ args }) => {
    const body = within(document.body);
    const confirm = await body.findByRole('button', { name: 'Deleting…' });
    await expect(confirm).toBeDisabled();
    await expect(body.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await expect(args.onOpenChange).not.toHaveBeenCalled();
  },
};

export const WithDetailsAndSecondaryAction: Story = {
  args: {
    title: 'Git is locked',
    description: 'Another Git operation may be running.',
    confirmText: 'Remove Lock and Archive',
    secondaryAction: { label: 'Retry', onClick: fn() },
    children: (
      <StatusCallout tone="warning">
        Remove the lock only if no other Git operation is running.
      </StatusCallout>
    ),
  },
};
