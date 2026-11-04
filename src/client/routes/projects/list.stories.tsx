import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { trpc } from '@/client/lib/trpc';
import ProjectsListPage from './list';

type ProjectsResponse = 'error' | 'empty' | 'projects';

const PROJECTS = [
  {
    id: 'project-alpha',
    name: 'Factory Factory',
    slug: 'factory-factory',
    repoPath: '/Users/example/code/factory-factory',
    defaultBranch: 'main',
    startupScriptCommand: null,
    startupScriptPath: null,
    _count: { workspaces: 7 },
  },
  {
    id: 'project-beta',
    name: 'Docs site',
    slug: 'docs-site',
    repoPath: '/Users/example/code/docs-site',
    defaultBranch: 'main',
    startupScriptCommand: 'pnpm install',
    startupScriptPath: null,
    _count: { workspaces: 1 },
  },
];

function ProjectsListStoryContent({ response }: { response: ProjectsResponse }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.path === 'project.list' && response === 'error') {
                observer.error(
                  new TRPCClientError('Unable to reach the Factory Factory backend (ECONNREFUSED)')
                );
                return;
              }
              const data = op.path === 'project.list' && response === 'projects' ? PROJECTS : [];
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    })
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AppHeaderProvider>
          <ProjectsListPage />
        </AppHeaderProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

/** Keyed by the control so changing it rebuilds the mocked client and cache. */
function ProjectsListStory({ response }: { response: ProjectsResponse }) {
  return <ProjectsListStoryContent key={response} response={response} />;
}

const meta = {
  title: 'Projects/ProjectsListPage',
  component: ProjectsListStory,
  parameters: { layout: 'fullscreen' },
  args: { response: 'projects' },
} satisfies Meta<typeof ProjectsListStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A failed load shows the error with Retry, never the first-run empty state. */
export const LoadError: Story = {
  args: { response: 'error' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent("Couldn't load projects");
    await expect(canvas.queryByText('No projects found.')).toBeNull();
  },
};

export const Empty: Story = {
  args: { response: 'empty' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No projects found.')).toBeVisible();
  },
};

export const Projects: Story = {
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Factory Factory')).toBeVisible();
  },
};
