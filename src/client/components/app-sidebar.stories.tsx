import type { Meta, StoryObj } from '@storybook/react';
import { type ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { StoryTrpcProvider } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import {
  IssueRefreshRecoveryFixture,
  exerciseIssueRefreshRecovery,
} from './project-issues-recovery.story-fixtures';

type State =
  | 'healthy'
  | 'failed'
  | 'loading'
  | 'empty'
  | 'project-switch'
  | 'issues-empty'
  | 'issues-ready'
  | 'issues-error'
  | 'issues-disconnected'
  | 'issues-recovery';

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

// Observe the sidebar's query without starting another request.
function IssueQueryStatus({ projectId }: { projectId: string }) {
  const query = trpc.github.listIssuesForProject.useQuery({ projectId }, { enabled: false });
  return (
    <output aria-label="Issue query status" className="sr-only">
      {query.status}
    </output>
  );
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
  const content = (
    <>
      {['issues-empty', 'issues-disconnected', 'issues-error'].includes(state) ? (
        <IssueQueryStatus projectId={switched ? 'other' : 'factory'} />
      ) : null}
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
    </>
  );
  return state === 'issues-recovery' ? (
    <IssueRefreshRecoveryFixture projectId="factory">{content}</IssueRefreshRecoveryFixture>
  ) : (
    <StoryTrpcProvider
      handlers={{
        'github.listIssuesForProject': () => ({
          issues:
            state === 'issues-ready'
              ? [
                  {
                    number: 42,
                    title: 'Fix login redirect',
                    body: '',
                    url: 'https://github.com/acme/repo/issues/42',
                    createdAt: '2026-11-01T12:00:00Z',
                    author: { login: 'octocat' },
                  },
                ]
              : [],
          error:
            state === 'issues-error'
              ? 'GitHub is unavailable'
              : state === 'issues-disconnected'
                ? 'Project is not linked to a GitHub repository'
                : null,
        }),
        'userSettings.get': () => ({ defaultSessionProvider: 'CLAUDE', ratchetEnabled: false }),
      }}
    >
      {content}
    </StoryTrpcProvider>
  );
}
const meta = {
  title: 'Navigation/AppSidebar',
  component: SidebarStory,
  render: (args) => <SidebarStory key={`${args.state}:${args.path ?? '/'}`} {...args} />,
  args: { state: 'healthy' },
  argTypes: {
    state: {
      control: 'select',
      options: [
        'healthy',
        'failed',
        'loading',
        'empty',
        'project-switch',
        'issues-empty',
        'issues-ready',
        'issues-error',
        'issues-disconnected',
        'issues-recovery',
      ],
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

export const TodoLaunch: Story = {
  args: { state: 'issues-ready' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const primary = await canvas.findByRole('button', { name: 'Start Fix login redirect' });
    await expect(canvas.getByRole('link', { name: 'Open #42 externally' })).toHaveAttribute(
      'target',
      '_blank'
    );
    await userEvent.click(primary);
    const sheet = await within(document.body).findByRole('dialog');
    await expect(within(sheet).getByRole('heading', { name: 'Start issue' })).toBeVisible();
  },
};
async function expectTodoHidden(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(async () => {
    await expect(canvas.getByLabelText('Issue query status')).toHaveTextContent('success');
  });
  await expect(canvas.queryByText('Todo')).not.toBeInTheDocument();
  await expect(canvas.queryByText('No assigned issues')).not.toBeInTheDocument();
}

export const TodoEmpty: Story = {
  args: { state: 'issues-empty' },
  play: async ({ canvasElement }) => expectTodoHidden(canvasElement),
};
export const TodoDisconnected: Story = {
  args: { state: 'issues-disconnected' },
  play: async ({ canvasElement }) => expectTodoHidden(canvasElement),
};
export const TodoError: Story = {
  args: { state: 'issues-error' },
  play: async ({ canvasElement }) => expectTodoHidden(canvasElement),
};

export const TodoRefreshRecovery: Story = {
  args: { state: 'issues-recovery' },
  play: async ({ canvasElement }) => exerciseIssueRefreshRecovery(canvasElement),
};
