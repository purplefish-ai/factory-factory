import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
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
};
