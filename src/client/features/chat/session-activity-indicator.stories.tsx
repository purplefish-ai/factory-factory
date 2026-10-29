import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SessionActivityIndicator } from './session-activity-indicator';

const meta = {
  title: 'Chat/SessionActivityIndicator',
  component: SessionActivityIndicator,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 3, activeGoals: 0 },
    onOpenAgents: fn(),
  },
} satisfies Meta<typeof SessionActivityIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeSubagents: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '3 sub-agents running' }));
    await expect(args.onOpenAgents).toHaveBeenCalledOnce();
  },
};

export const OneSubagent: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 1, activeGoals: 0 },
  },
};

export const TwoSubagents: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 },
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};

export const ManySubagents: Story = {
  args: {
    work: { promptInFlight: false, backgroundTasks: [], runningSubagents: 12, activeGoals: 0 },
  },
};

export const WithSessionActivity: Story = {
  args: {
    work: {
      promptInFlight: true,
      backgroundTasks: [{ id: 'tests', name: 'pnpm test', kind: 'shell' }],
      runningSubagents: 3,
      activeGoals: 0,
    },
  },
};

export const WithoutNavigation: Story = {
  args: { onOpenAgents: undefined },
};
