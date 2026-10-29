import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useState } from 'react';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';

type State = 'healthy' | 'failed' | 'loading' | 'empty' | 'project-switch';
function SidebarStory({ state }: { state: State }) {
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () => () =>
          observable((observer) => {
            observer.next({ result: { data: { issues: [] } } });
            observer.complete();
          }),
      ],
    })
  );
  const [switched, setSwitched] = useState(false);
  const summary =
    state === 'loading' || switched
      ? undefined
      : {
          totalCount: state === 'empty' ? 0 : 3,
          failedCount: state === 'failed' ? 1 : 0,
        };
  const navData: AppNavigationData = {
    projects: undefined,
    projectsError: null,
    refetchProjects: () => Promise.reject(new Error('Static fixture')),
    selectedProjectSlug: switched ? 'other' : 'factory',
    selectedProjectId: switched ? 'other' : 'factory',
    selectProjectSlug: () => undefined,
    issueProvider: 'GITHUB',
    serverWorkspaces: [],
    reviewCount: 0,
    agentsSummary: summary,
    needsAttention: () => false,
    clearAttention: () => undefined,
    currentWorkspaceId: undefined,
  };
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {state === 'project-switch' ? (
          <button type="button" onClick={() => setSwitched((value) => !value)}>
            Switch project
          </button>
        ) : null}
        <SidebarProvider className="h-[640px] min-h-0">
          <AppSidebar navData={navData} />
        </SidebarProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: 'Navigation/Agents badge',
  component: SidebarStory,
  render: (args) => <SidebarStory key={args.state} {...args} />,
  args: { state: 'healthy' },
  argTypes: {
    state: {
      control: 'select',
      options: ['healthy', 'failed', 'loading', 'empty', 'project-switch'],
    },
  },
} satisfies Meta<typeof SidebarStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Healthy: Story = {};
export const Failed: Story = { args: { state: 'failed' } };
export const Loading: Story = { args: { state: 'loading' } };
export const Empty: Story = { args: { state: 'empty' } };
export const ProjectSwitch: Story = { args: { state: 'project-switch' } };
