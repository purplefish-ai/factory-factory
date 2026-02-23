import type { Meta, StoryObj } from '@storybook/react';
import { Loading } from './loading';

const meta = {
  title: 'Common/Loading',
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
    message: 'Fetching workspaces...',
  },
};

export const LongMessage: Story = {
  args: {
    message: 'Initializing workspace and setting up git worktree...',
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
    message: 'Loading...',
  },
};
