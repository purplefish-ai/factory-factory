import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@/components/ui/button';
import { WorkspaceSwitcherDropdown } from './workspace-switcher-dropdown';

const meta = {
  title: 'Workspaces/WorkspaceSwitcherDropdown',
  component: WorkspaceSwitcherDropdown,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="flex w-[32rem] items-center gap-1 border p-2">
        <Story />
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost">
            Settings
          </Button>
          <Button size="sm" variant="ghost">
            Archive
          </Button>
          <Button size="sm" variant="ghost">
            Panel
          </Button>
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof WorkspaceSwitcherDropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LongBranchOnSmallerDisplay: Story = {
  args: {
    projectSlug: 'factory-factory',
    projectId: 'project-1',
    currentWorkspaceId: 'workspace-1',
    currentWorkspaceLabel:
      'martin-purplefish/smaller-displays-top-bar-starts-overlapping-fixed-controls',
    currentWorkspaceName: 'Prevent top-bar overlap',
  },
};
