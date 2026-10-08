import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { z } from 'zod';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RatchetingMenuItems } from './ratcheting-toggle';
import type { WorkspaceHeaderWorkspace } from './types';

const workspace = {
  id: 'mock-workspace',
  projectId: 'mock-project',
  ratchetEnabled: false,
} as WorkspaceHeaderWorkspace;
function MobileRecipientFlow() {
  const monitoring = useToggleRatcheting(workspace.projectId);
  return (
    <>
      {monitoring.recipientPicker}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>More actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <RatchetingMenuItems
            workspace={workspace}
            workspaceId={workspace.id}
            toggleRatcheting={monitoring}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
const meta = {
  title: 'Workspaces/RatchetingToggle',
  component: MobileRecipientFlow,
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
                      data: input.recipientSessionId
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
            <Story />
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
} satisfies Meta<typeof MobileRecipientFlow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MobileRecipientSelection: Story = {};
