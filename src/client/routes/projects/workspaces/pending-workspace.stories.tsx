import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { setPendingWorkspace } from '@/client/lib/pending-workspace';
import { PendingWorkspace } from './pending-workspace';

const meta = {
  title: 'Workspace/PendingWorkspace',
  component: PendingWorkspace,
  args: { id: 'optimistic-story', slug: 'project' },
} satisfies Meta<typeof PendingWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Creating: Story = {
  args: { id: 'optimistic-story-creating' },
  beforeEach: () => {
    setPendingWorkspace('optimistic-story-creating', { status: 'creating', name: 'Fix login' });
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Creating Fix login');
  },
};

export const Failed: Story = {
  args: { id: 'optimistic-story-failed' },
  beforeEach: () => {
    setPendingWorkspace('optimistic-story-failed', {
      status: 'failed',
      message: "Couldn't create workspace. Claude CLI is unavailable.",
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Claude CLI is unavailable');
    await expect(canvas.getByRole('link')).toHaveAttribute(
      'href',
      '/projects/project/workspaces?new=1'
    );
  },
};

export const AfterReload: Story = {};
