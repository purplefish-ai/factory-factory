import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { WorkflowSelector } from './workflow-selector';

const meta = {
  title: 'Workspace/WorkflowSelector',
  component: WorkflowSelector,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    onSelect: fn(),
    workspaceId: 'mock-workspace-id',
  },
} satisfies Meta<typeof WorkflowSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockWorkflows = [
  {
    id: 'feature',
    name: 'Feature',
    description: 'Build a new feature from scratch',
    expectsPR: true,
    content: '# Feature workflow\n\nBuild a new feature.',
  },
  {
    id: 'bugfix',
    name: 'Bug Fix',
    description: 'Fix an existing issue or bug',
    expectsPR: true,
    content: '# Bugfix workflow\n\nFix an issue.',
  },
  {
    id: 'explore',
    name: 'Explore',
    description: 'Investigate the codebase or research a topic',
    expectsPR: false,
    content: '# Explore workflow\n\nResearch and explore.',
  },
  {
    id: 'followup',
    name: 'Follow Up',
    description: 'Continue work from a previous session',
    expectsPR: false,
    content: '# Followup workflow\n\nContinue previous work.',
  },
];

export const Default: Story = {
  args: {
    workflows: mockWorkflows,
    recommendedWorkflow: 'feature',
  },
};

export const BugfixRecommended: Story = {
  args: {
    workflows: mockWorkflows,
    recommendedWorkflow: 'bugfix',
  },
};

export const Disabled: Story = {
  args: {
    workflows: mockWorkflows,
    recommendedWorkflow: 'feature',
    disabled: true,
  },
};

export const SingleWorkflow: Story = {
  args: {
    workflows: [mockWorkflows[0]],
    recommendedWorkflow: 'feature',
  },
};

export const TwoWorkflows: Story = {
  args: {
    workflows: mockWorkflows.slice(0, 2),
    recommendedWorkflow: 'feature',
  },
};
