import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ThemeProvider } from '@/frontend/components/theme-provider';
import { TRPCProvider } from '@/frontend/lib/providers';
import { AppSidebar } from './app-sidebar';
import type { ServerWorkspace, WorkspaceListItem } from './use-workspace-list-state';

const now = new Date();

const mockWorkspaces: ServerWorkspace[] = [
  {
    id: 'ws-1',
    name: 'Refactor auth flows',
    createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    branchName: 'feature/refactor-auth-flow',
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
    ratchetEnabled: true,
    ratchetState: 'READY',
    isWorking: true,
    gitStats: { total: 12, additions: 120, deletions: 45, hasUncommitted: false },
    lastActivityAt: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
  },
  {
    id: 'ws-2',
    name: 'Polish Kanban layout',
    createdAt: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
    branchName: 'chore/kanban-layout-alignments',
    prUrl: 'https://github.com/example/repo/pull/57',
    prNumber: 57,
    prState: 'MERGED',
    prCiStatus: 'SUCCESS',
    ratchetEnabled: true,
    ratchetState: 'MERGED',
    isWorking: false,
    gitStats: { total: 3, additions: 0, deletions: 0, hasUncommitted: false },
    lastActivityAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ws-3',
    name: 'Debug CI flake',
    createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
    branchName: 'fix/ci-flake-runs-forever',
    prUrl: 'https://github.com/example/repo/pull/63',
    prNumber: 63,
    prState: 'OPEN',
    prCiStatus: 'FAILURE',
    ratchetEnabled: true,
    ratchetState: 'CI_FAILED',
    isWorking: false,
    gitStats: { total: 9, additions: 12, deletions: 8, hasUncommitted: true },
    lastActivityAt: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'ws-4',
    name: 'Research indexing approach',
    createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    branchName: 'research/semantic-indexing',
    prUrl: null,
    prNumber: null,
    prState: 'NONE',
    prCiStatus: 'UNKNOWN',
    ratchetEnabled: false,
    ratchetState: 'IDLE',
    isWorking: false,
    gitStats: null,
    lastActivityAt: null,
  },
  {
    id: 'ws-5',
    name: 'Archive onboarding cleanup',
    createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    branchName: 'cleanup/onboarding',
    prUrl: 'https://github.com/example/repo/pull/71',
    prNumber: 71,
    prState: 'CLOSED',
    prCiStatus: 'FAILURE',
    ratchetEnabled: true,
    ratchetState: 'READY',
    isWorking: false,
    gitStats: { total: 0, additions: 0, deletions: 0, hasUncommitted: false },
    lastActivityAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

const mockData = {
  projects: [
    { id: 'proj-1', slug: 'alpha', name: 'Alpha Studio' },
    { id: 'proj-2', slug: 'beta', name: 'Beta Platform' },
  ],
  selectedProjectSlug: 'alpha',
  projectState: {
    workspaces: mockWorkspaces,
    reviewCount: 3,
  },
};

function SidebarStoryFrame({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <TRPCProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </TRPCProvider>
    </ThemeProvider>
  );
}

const meta = {
  title: 'Navigation/AppSidebar',
  component: AppSidebar,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <SidebarStoryFrame>
        <div className="h-svh w-[320px] bg-background">
          <Story />
        </div>
      </SidebarStoryFrame>
    ),
  ],
  args: {
    mockData,
  },
  tags: ['autodocs'],
} satisfies Meta<typeof AppSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    mockData: {
      ...mockData,
      projectState: {
        workspaces: [],
        reviewCount: 0,
      },
    },
  },
};

export const WithArchiving: Story = {
  args: {
    mockData: {
      ...mockData,
      projectState: {
        workspaces: [
          {
            ...mockWorkspaces[0],
            id: 'ws-archiving',
            name: 'Archiving workspace',
            uiState: 'archiving' as const,
          } as WorkspaceListItem,
          ...mockWorkspaces.slice(1),
        ],
        reviewCount: 3,
      },
    },
  },
};
