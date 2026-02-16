import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ResumeBranchDialog } from './resume-branch-dialog';

const branches = [
  {
    name: 'feature/auth-flow',
    displayName: 'feature/auth-flow',
    refType: 'local' as const,
  },
  {
    name: 'remotes/origin/fix/ci-timeouts',
    displayName: 'fix/ci-timeouts',
    refType: 'remote' as const,
  },
  {
    name: 'remotes/origin/chore/update-deps',
    displayName: 'chore/update-deps',
    refType: 'remote' as const,
  },
];

const meta = {
  title: 'Pages/Workspaces/ResumeBranchDialog',
  component: ResumeBranchDialog,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="relative min-h-screen bg-background">
        <div className="p-6 text-muted-foreground">Workspaces page content behind dialog</div>
        <Story />
      </div>
    ),
  ],
  args: {
    open: true,
    onOpenChange: fn(),
    branches,
    isLoading: false,
    isSubmitting: false,
    onSelectBranch: fn(),
  },
} satisfies Meta<typeof ResumeBranchDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BranchesAvailable: Story = {};

export const Loading: Story = {
  args: {
    branches: [],
    isLoading: true,
  },
};

export const Empty: Story = {
  args: {
    branches: [],
    isLoading: false,
  },
};

export const Submitting: Story = {
  args: {
    isSubmitting: true,
  },
};
