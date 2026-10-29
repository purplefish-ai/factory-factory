import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PRDeliveryMode } from '@/shared/pr-monitoring';
import { RatchetingToggle } from './ratcheting-toggle';
import type { WorkspaceHeaderWorkspace } from './types';

const workspace = {
  id: 'mock-workspace',
  projectId: 'mock-project',
  ratchetEnabled: false,
} as WorkspaceHeaderWorkspace;
function RatchetingDropdown({
  deliveryMode = PRDeliveryMode.MAIN,
  enabled = false,
  animated = false,
  archived = false,
  withPr = false,
}: {
  deliveryMode?: PRDeliveryMode;
  enabled?: boolean;
  animated?: boolean;
  archived?: boolean;
  withPr?: boolean;
}) {
  const displayedWorkspace = {
    ...workspace,
    status: archived ? 'ARCHIVED' : 'READY',
    worktreePath: '/tmp/workspace',
    ratchetState: animated ? 'CI_RUNNING' : 'IDLE',
    ratchetEnabled: enabled,
    ratchetButtonAnimated: animated,
    prs: withPr
      ? [
          {
            id: 'pr-42',
            url: 'https://github.com/team/repository/pull/42',
            number: 42,
            title: 'Simplify workspace PR controls',
            headRefName: 'feature/pr-menu',
            baseRefName: 'main',
            state: 'OPEN',
            reviewState: null,
            ciStatus: 'SUCCESS',
            hasMergeConflict: false,
            syncedAt: null,
          },
        ]
      : [],
    prMonitoring: {
      deliveryMode,
      enabled,
      recipientSessionId: null,
      bindingRevision: 1,
      pauseReason: null,
      pendingEventCount: 0,
    },
  } as WorkspaceHeaderWorkspace;
  return <RatchetingToggle workspace={displayedWorkspace} workspaceId={workspace.id} />;
}
const meta = {
  title: 'Workspaces/RatchetingToggle',
  component: RatchetingDropdown,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => {
      const [queryClient] = useState(() => new QueryClient());
      const [client] = useState(() =>
        trpc.createClient({
          links: [
            () =>
              ({ op }) =>
                observable((observer) => {
                  const input = z
                    .object({ recipientSessionId: z.string().nullable().optional() })
                    .passthrough()
                    .parse(op.input);
                  observer.next({
                    result: {
                      data:
                        input.recipientSessionId || input.deliveryMode === PRDeliveryMode.DEDICATED
                          ? {
                              status: 'enabled',
                            }
                          : {
                              status: 'recipient_required',
                              bindingRevision: 1,
                              candidates: [
                                { id: 'main', name: 'Implementation', provider: 'claude' },
                                { id: 'other', name: 'Follow-up', provider: 'codex' },
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
            <TooltipProvider>
              <Story />
            </TooltipProvider>
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
} satisfies Meta<typeof RatchetingDropdown>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MobileRecipientSelection: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const MobileDedicatedDestination: Story = {
  args: { deliveryMode: PRDeliveryMode.DEDICATED, enabled: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const UpdatesOff: Story = {};
export const UpdatesOn: Story = { args: { enabled: true, withPr: true } };
export const ActiveUpdates: Story = {
  args: { enabled: true, animated: true, withPr: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', {
        name: 'Pull requests and updates, updates on (CI in progress)',
      })
    ).toBeVisible();
  },
};
export const Archived: Story = { args: { archived: true, withPr: true } };
