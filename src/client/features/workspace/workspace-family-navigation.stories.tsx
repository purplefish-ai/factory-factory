import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { WorkspaceFamilyMenu, WorkspaceParentLink } from './workspace-family-navigation';

const parent = {
  id: 'parent',
  name: 'Authentication refactor across the API and frontend projects',
  projectId: 'api',
  projectName: 'API',
  projectSlug: 'api',
};
const child = {
  id: 'child',
  name: 'Token refresh',
  projectId: 'web',
  status: 'READY' as const,
  kanbanColumn: 'WORKING' as const,
  parentWorkspace: parent,
  childWorkspaceCount: 0,
};
function StoryProvider({
  children,
  error = false,
  loading = false,
}: {
  children: ReactNode;
  error?: boolean;
  loading?: boolean;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (loading) {
                return;
              }
              if (error) {
                observer.error(TRPCClientError.from(new Error('Family temporarily unavailable')));
                return;
              }
              const data =
                op.path === 'workspace.listChildren'
                  ? [
                      { ...child, projectName: 'Web', projectSlug: 'web' },
                      {
                        ...child,
                        id: 'sibling',
                        name: 'Auth regression tests',
                        projectId: 'api',
                        projectName: 'API',
                        projectSlug: 'api',
                        kanbanColumn: 'DONE',
                      },
                    ]
                  : { ...parent, status: 'READY', kanbanColumn: 'WAITING' };
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: 'Workspace/Family Navigation',
  component: WorkspaceFamilyMenu,
  args: { workspace: child, projectSlug: 'web' },
  decorators: [
    (Story) => (
      <StoryProvider>
        <div className="flex w-80 min-w-0 items-center gap-2 rounded-lg border p-3">
          <WorkspaceParentLink parent={parent} projectId="web" />
          <Story />
        </div>
      </StoryProvider>
    ),
  ],
} satisfies Meta<typeof WorkspaceFamilyMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CrossProjectChild: Story = {};
export const Parent: Story = {
  args: {
    workspace: {
      ...child,
      id: 'parent',
      name: parent.name,
      parentWorkspace: null,
      childWorkspaceCount: 2,
    },
  },
};
export const IconOnly: Story = { args: { iconOnly: true } };
export const Unavailable: Story = {
  decorators: [
    (Story) => (
      <StoryProvider error>
        <Story />
      </StoryProvider>
    ),
  ],
};
export const Loading: Story = {
  decorators: [
    (Story) => (
      <StoryProvider loading>
        <Story />
      </StoryProvider>
    ),
  ],
};
