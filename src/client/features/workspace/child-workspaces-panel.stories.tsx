import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { z } from 'zod';
import { trpc } from '@/client/lib/trpc';
import { ChildWorkspacesPanel } from './child-workspaces-panel';

const projectFilters = z.object({ isArchived: z.boolean().optional() }).optional();
const projects = [
  { id: 'active', name: 'Active project', isArchived: false },
  { id: 'archived', name: 'Archived project', isArchived: true },
];

function StoryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const filter =
                op.path === 'project.list' ? projectFilters.parse(op.input) : undefined;
              const data =
                op.path === 'project.list'
                  ? projects.filter(
                      (project) =>
                        filter?.isArchived === undefined || project.isArchived === filter.isArchived
                    )
                  : [];
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
  title: 'Workspace/Child Workspaces',
  component: ChildWorkspacesPanel,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <StoryProvider>
        <div className="h-80 w-[420px]">
          <Story />
        </div>
      </StoryProvider>
    ),
  ],
  args: { workspaceId: 'parent-1' },
} satisfies Meta<typeof ChildWorkspacesPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveProjectPicker: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTitle('New child workspace'));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole('combobox'));
    await expect(await body.findByRole('option', { name: 'Active project' })).toBeVisible();
    await expect(body.queryByRole('option', { name: 'Archived project' })).toBeNull();
  },
};
