import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
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

const statusChildren = ['READY', 'PROVISIONING', 'FAILED'].map((status, index) => ({
  id: `child-${index}`,
  name: `${status.toLowerCase()} workspace`,
  status,
  projectSlug: 'project',
  projectName: 'Project',
  kanbanColumn: null,
}));

function getStoryData(path: string, input: unknown, childStatuses: boolean) {
  if (path !== 'project.list') {
    return childStatuses ? statusChildren : [];
  }
  const filter = projectFilters.parse(input);
  return projects.filter(
    (project) => filter?.isArchived === undefined || project.isArchived === filter.isArchived
  );
}

function StoryProvider({
  children,
  failChildren = false,
  childStatuses = false,
}: {
  children: ReactNode;
  failChildren?: boolean;
  childStatuses?: boolean;
}) {
  const [failed] = useState({ value: false });
  const shouldFailChildren = (path: string) =>
    failChildren && path === 'workspace.listChildren' && !failed.value;
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
              if (shouldFailChildren(op.path)) {
                failed.value = true;
                observer.error(new TRPCClientError('Offline'));
                return;
              }
              const data = getStoryData(op.path, op.input, childStatuses);
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
  title: 'Workspace/ChildWorkspacesPanel',
  component: ChildWorkspacesPanel,
  parameters: { layout: 'centered' },
  decorators: [
    (Story, context) => (
      <StoryProvider
        failChildren={context.parameters.failChildren === true}
        childStatuses={context.parameters.childStatuses === true}
      >
        <div className="h-80 w-[420px] max-w-[calc(100vw-2rem)]">
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
    await userEvent.click(canvas.getByRole('button', { name: 'New child workspace' }));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole('combobox'));
    await expect(await body.findByRole('option', { name: 'Active project' })).toBeVisible();
    await expect(body.queryByRole('option', { name: 'Archived project' })).toBeNull();
  },
};

/** With no children, the empty state offers the creation action. */
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No child workspaces yet')).toBeVisible();
    // The header's icon button shares the name; click the labeled empty-state action.
    await userEvent.click(canvas.getByText('New child workspace', { selector: 'button' }));
    await expect(await within(canvasElement.ownerDocument.body).findByRole('dialog')).toBeVisible();
  },
};

export const EmptyDark: Story = {
  globals: { theme: 'dark' },
};

export const ActiveProjectPickerDark: typeof ActiveProjectPicker = {
  ...ActiveProjectPicker,
  globals: { theme: 'dark' },
};

export const RecoverableError: Story = {
  parameters: { failChildren: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Offline');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(await canvas.findByText('No child workspaces yet')).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};
export const RecoverableErrorDark: Story = { ...RecoverableError, globals: { theme: 'dark' } };
export const RecoverableErrorPhone: Story = {
  ...RecoverableError,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async (context) => {
    await RecoverableError.play?.(context);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const StatusShapes: Story = {
  parameters: { childStatuses: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ['ready', 'provisioning', 'failed']) {
      const indicator = await canvas.findByRole('img', { name });
      await expect(indicator.querySelector('svg')).not.toBeNull();
    }
  },
};
