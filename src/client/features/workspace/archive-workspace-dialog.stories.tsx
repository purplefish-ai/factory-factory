import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
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

export const Default: Story = {};

export const WithActiveChildren: Story = {
  args: {
    activeChildCount: 2,
  },
};
