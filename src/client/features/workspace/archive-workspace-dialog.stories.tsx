import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ArchiveWorkspaceDialog } from './archive-workspace-dialog';

const meta = {
  title: 'Workspace/ArchiveWorkspaceDialog',
  component: ArchiveWorkspaceDialog,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof ArchiveWorkspaceDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async () => {
    const dialog = within(document.body).getByRole('alertdialog');
    await expect(within(dialog).getByRole('heading', { name: 'Archive workspace?' })).toBeVisible();
    await expect(dialog).toHaveTextContent('Running agents and processes will stop.');
    await expect(dialog).toHaveTextContent('Chat history and the branch are kept.');
    await expect(dialog).toHaveTextContent('cannot be undone in the app.');
    await expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeEnabled();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };

export const WithActiveChildren: Story = {
  args: {
    activeChildCount: 2,
  },
  play: async ({ args }) => {
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('This workspace has 2 active child workspaces.');
    const archive = within(dialog).getByRole('button', { name: 'Archive' });
    // Radix lifts the body's pointer lock once the modal has mounted.
    await waitFor(() => expect(getComputedStyle(archive).pointerEvents).not.toBe('none'));
    await userEvent.click(archive);
    // Archiving is optimistic: confirming closes the dialog at once.
    await expect(args.onConfirm).toHaveBeenCalledOnce();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};

/** Archiving again after an archive that stopped partway does not commit again. */
export const ArchiveIncomplete: Story = {
  args: {
    archiveIncomplete: true,
  },
  play: async ({ args }) => {
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(
      within(dialog).getByRole('heading', { name: 'Finish archiving workspace?' })
    ).toBeVisible();
    await expect(dialog).toHaveTextContent('The last archive of this workspace stopped partway');
    await expect(dialog).toHaveTextContent('so nothing is committed again.');
    await expect(dialog).not.toHaveTextContent('will be committed');
    const archive = within(dialog).getByRole('button', { name: 'Archive again' });
    await waitFor(() => expect(getComputedStyle(archive).pointerEvents).not.toBe('none'));
    await userEvent.click(archive);
    await expect(args.onConfirm).toHaveBeenCalledOnce();
  },
};
