import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { baseWorkspace } from '@/client/features/kanban/kanban-card.stories';
import { trpc } from '@/client/lib/trpc';
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

// Both idle and pending-request workspaces belong to the same Waiting group.
export const KanbanGroups: Story = {
  args: {
    projectSlug: 'factory-factory',
    projectId: 'project-1',
    currentWorkspaceId: 'waiting-idle',
    currentWorkspaceLabel: 'feature/ready-for-next-prompt',
    currentWorkspaceName: 'Ready for next prompt',
  },
  decorators: [
    function WorkspaceGroups(Story) {
      const [queryClient] = useState(() => new QueryClient());
      const [client] = useState(() =>
        trpc.createClient({
          links: [
            () => () =>
              observable((observer) => {
                observer.next({
                  result: {
                    data: {
                      reviewCount: 0,
                      workspaces: [
                        {
                          ...baseWorkspace,
                          id: 'working',
                          name: 'Agent working',
                          kanbanColumn: 'WORKING',
                          isWorking: true,
                        },
                        {
                          ...baseWorkspace,
                          id: 'waiting-idle',
                          name: 'Ready for next prompt',
                          kanbanColumn: 'WAITING',
                        },
                        {
                          ...baseWorkspace,
                          id: 'waiting-review',
                          name: 'Review requested',
                          kanbanColumn: 'WAITING',
                          pendingRequestType: 'REVIEW',
                        },
                        {
                          ...baseWorkspace,
                          id: 'done',
                          name: 'Completed work',
                          kanbanColumn: 'DONE',
                        },
                      ],
                    },
                  },
                });
                observer.complete();
              }),
          ],
        })
      );
      return (
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <Story />
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
};
