import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { expect, within } from 'storybook/test';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';

type State = 'healthy' | 'failed' | 'loading' | 'empty' | 'project-switch';

/** Moves Storybook's shared MemoryRouter to the story's route before rendering. */
function AtRoute({ path, children }: { path: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    void navigate(path, { replace: true });
  }, [navigate, path]);
  return pathname === path ? children : null;
}

function OpenMobileSheet() {
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(true), [setOpenMobile]);
  return null;
}

function SidebarStory({
  state,
  path = '/',
  mobileOpen = false,
}: {
  state: State;
  path?: string;
  mobileOpen?: boolean;
}) {
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
        <AtRoute path={path}>
          <SidebarProvider className="h-[640px] min-h-0">
            {mobileOpen ? <OpenMobileSheet /> : null}
            <AppSidebar navData={navData} />
          </SidebarProvider>
        </AtRoute>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: 'Navigation/Agents badge',
  component: SidebarStory,
  render: (args) => <SidebarStory key={`${args.state}:${args.path ?? '/'}`} {...args} />,
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

export const NewWorkspaceImageDrop: Story = {
  play: ({ canvasElement }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['image'], 'reference.png', { type: 'image/png' }));
    const target = canvasElement.querySelector('[data-sidebar="content"]');
    if (!target) {
      throw new Error('Sidebar workspace content not found');
    }
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
  },
};

const boardHref = '/projects/factory/workspaces';

/** Board is the project landing page and the first project link in the footer. */
export const BoardActive: Story = {
  args: { path: boardHref },
  play: async ({ canvasElement }) => {
    const board = await within(canvasElement).findByRole('link', { name: 'Board' });
    await expect(board).toHaveAttribute('href', boardHref);
    await expect(board).toHaveAttribute('aria-current', 'page');
    await expect(board).toHaveAttribute('data-active', 'true');
  },
};

/** On workspace detail the workspace row is current, not Board, despite the shared URL prefix. */
export const BoardInactiveOnWorkspace: Story = {
  args: { path: `${boardHref}/workspace-1` },
  play: async ({ canvasElement }) => {
    const board = await within(canvasElement).findByRole('link', { name: 'Board' });
    await expect(board).not.toHaveAttribute('aria-current');
    await expect(board).toHaveAttribute('data-active', 'false');
  },
};

/** Phones show the same footer, including Board, in the full-screen navigation sheet. */
export const MobileSheet: Story = {
  args: { path: `${boardHref}/workspace-1`, mobileOpen: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  parameters: { layout: 'fullscreen' },
  play: async ({ canvasElement }) => {
    const sheet = await within(canvasElement.ownerDocument.body).findByRole('dialog');
    await expect(within(sheet).getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      boardHref
    );
  },
};
