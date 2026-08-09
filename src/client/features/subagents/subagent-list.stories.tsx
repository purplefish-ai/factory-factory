import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent, within } from 'storybook/test';
import { SubagentList } from './subagent-list';
import type { SubagentListItem } from './types';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const activeSubagents: SubagentListItem[] = [
  {
    id: 'agent-security',
    name: 'Security review',
    status: 'running',
    createdAt: minutesAgo(12),
    updatedAt: minutesAgo(1),
    completedAt: null,
    latestActivity: 'Checking authentication and permission boundaries',
    resultPreview: null,
  },
  {
    id: 'agent-tests',
    name: null,
    status: 'waiting',
    createdAt: minutesAgo(5),
    updatedAt: minutesAgo(1),
    completedAt: null,
    latestActivity: 'Waiting for the test process to finish',
    resultPreview: null,
  },
];

const completedSubagents: SubagentListItem[] = [
  {
    id: 'agent-docs',
    name: 'Documentation scan',
    status: 'completed',
    createdAt: minutesAgo(40),
    updatedAt: minutesAgo(20),
    completedAt: minutesAgo(20),
    latestActivity: null,
    resultPreview: 'Found two guides that need updated examples.',
  },
  {
    id: 'agent-build',
    name: 'Build verification',
    status: 'failed',
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(10),
    completedAt: minutesAgo(10),
    latestActivity: null,
    resultPreview: 'Storybook build stopped on a missing icon export.',
  },
];

const meta = {
  title: 'Subagents/SubagentList',
  component: SubagentList,
  decorators: [
    (Story) => (
      <div className="h-[520px] w-[320px] overflow-y-auto border bg-background">
        <Story />
      </div>
    ),
  ],
  args: { onSelect: fn() },
} satisfies Meta<typeof SubagentList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { state: { kind: 'ready', subagents: [] } } };

export const ActiveOnly: Story = {
  args: { state: { kind: 'ready', subagents: activeSubagents } },
};

export const MixedCollapsed: Story = {
  args: { state: { kind: 'ready', subagents: [...activeSubagents, ...completedSubagents] } },
};

export const MixedExpanded: Story = {
  args: { state: { kind: 'ready', subagents: [...activeSubagents, ...completedSubagents] } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Completed · 2' }));
  },
};

export const Loading: Story = { args: { state: { kind: 'loading' } } };

export const Unsupported: Story = { args: { state: { kind: 'unsupported' } } };

export const ListError: Story = {
  args: {
    state: { kind: 'error', message: 'The provider could not list sub-agents.', onRetry: fn() },
  },
};
