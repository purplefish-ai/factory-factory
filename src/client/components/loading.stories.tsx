import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { Loading } from './loading';

const meta = {
  title: 'Shared/Loading',
  component: Loading,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[400px] h-[300px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Loading>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const CustomMessage: Story = {
  args: {
    message: 'Fetching workspaces…',
  },
};

export const LongMessage: Story = {
  args: {
    message: 'Initializing workspace and setting up git worktree…',
  },
};

export const InSmallContainer: Story = {
  decorators: [
    (Story) => (
      <div className="w-[200px] h-[200px] border rounded">
        <Story />
      </div>
    ),
  ],
  args: {
    message: 'Loading…',
  },
};

/** Side panels drop the minimum height. */
export const Compact: Story = {
  decorators: [
    (Story) => (
      <div className="w-[280px] h-[160px] border rounded">
        <Story />
      </div>
    ),
  ],
  args: {
    size: 'compact',
    message: 'Loading changes…',
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  args: {
    message: 'Loading workspace…',
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Loading workspace…');
  },
};
