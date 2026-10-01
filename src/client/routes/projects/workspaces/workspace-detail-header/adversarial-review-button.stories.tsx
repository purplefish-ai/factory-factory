import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { AdversarialReviewButton } from './adversarial-review-button';
import type { WorkspaceHeaderWorkspace } from './types';

const fixture: Partial<WorkspaceHeaderWorkspace> = {
  id: 'mock-workspace',
  status: 'READY',
  worktreePath: '/mock/worktree',
  prUrl: 'https://github.com/example/repo/pull/42',
  prNumber: 42,
  prState: 'OPEN',
  ratchetState: 'IDLE',
  sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
};
const workspace = fixture as WorkspaceHeaderWorkspace;

const meta = {
  title: 'Workspaces/AdversarialReviewButton',
  component: AdversarialReviewButton,
  args: { workspace, workspaceId: workspace.id },
  decorators: [
    (Story, context) => {
      const [queryClient] = useState(() => new QueryClient());
      const [client] = useState(() =>
        trpc.createClient({
          links: [
            () =>
              ({ op }) =>
                observable((observer) => {
                  if (op.path !== 'adversarialReview.trigger') {
                    observer.error(new TRPCClientError(`No story fixture for ${op.path}`));
                    return;
                  }
                  observer.next({
                    result: { data: { status: 'started', sessionId: 'mock-review' } },
                  });
                  observer.complete();
                }),
          ],
        })
      );
      return (
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            {context.args.renderAsMenuItem ? (
              <DropdownMenu open modal={false}>
                <DropdownMenuContent>
                  <Story />
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Story />
            )}
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
} satisfies Meta<typeof AdversarialReviewButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const NoWorktree: Story = {
  args: { workspace: { ...workspace, worktreePath: null } },
};
export const Provisioning: Story = {
  args: { workspace: { ...workspace, status: 'PROVISIONING', worktreePath: null } },
};
export const FailedWithoutWorktree: Story = {
  args: { workspace: { ...workspace, status: 'FAILED', worktreePath: null } },
};
export const FailedWithWorktree: Story = {
  args: { workspace: { ...workspace, status: 'FAILED' } },
};
export const OverflowReady: Story = { args: { renderAsMenuItem: true } };
export const OverflowNoWorktree: Story = {
  args: { renderAsMenuItem: true, workspace: { ...workspace, worktreePath: null } },
};
