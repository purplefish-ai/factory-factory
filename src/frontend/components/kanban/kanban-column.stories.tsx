import type { Meta, StoryObj } from '@storybook/react';
import type { WorkspaceWithKanban } from './kanban-card';
import { KANBAN_COLUMNS, KanbanColumn } from './kanban-column';

const meta = {
  title: 'Kanban/KanbanColumn',
  component: KanbanColumn,
  parameters: {
    layout: 'centered',
    nextjs: {
      appDirectory: true,
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof KanbanColumn>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseWorkspace: WorkspaceWithKanban = {
  id: 'ws-1',
  name: 'Add user authentication',
  description: 'Implement OAuth2 login flow',
  branchName: 'feature/auth',
  projectId: 'proj-1',
  worktreePath: '/path/to/worktree',
  prUrl: null,
  prNumber: null,
  prState: 'NONE',
  prReviewState: null,
  prCiStatus: 'UNKNOWN',
  prUpdatedAt: null,
  status: 'READY',
  createdAt: new Date(),
  updatedAt: new Date(),
  kanbanColumn: 'IN_PROGRESS',
  isWorking: false,
  errorMessage: null,
  provisioningStartedAt: null,
  provisioningCompletedAt: null,
  retryCount: 0,
  githubIssueNumber: null,
  githubIssueUrl: null,
  hasHadSessions: true,
  cachedKanbanColumn: 'IN_PROGRESS',
  stateComputedAt: new Date(),
};

const mockWorkspaces: WorkspaceWithKanban[] = [
  baseWorkspace,
  {
    ...baseWorkspace,
    id: 'ws-2',
    name: 'Fix login validation',
    branchName: 'fix/login',
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
  },
  {
    ...baseWorkspace,
    id: 'ws-3',
    name: 'Update dependencies',
    branchName: 'chore/deps',
    isWorking: true,
  },
];

// Define columns directly to avoid non-null assertions
const inProgressColumn = {
  id: 'IN_PROGRESS' as const,
  label: 'In Progress',
  description: 'Actively working',
};
const backlogColumn = { id: 'BACKLOG' as const, label: 'Backlog', description: 'Not started yet' };
const prOpenColumn = { id: 'PR_OPEN' as const, label: 'PR Open', description: 'Under review' };

export const Empty: Story = {
  args: {
    column: backlogColumn,
    workspaces: [],
    projectSlug: 'my-project',
  },
};

export const SingleWorkspace: Story = {
  args: {
    column: inProgressColumn,
    workspaces: [baseWorkspace],
    projectSlug: 'my-project',
  },
};

export const MultipleWorkspaces: Story = {
  args: {
    column: inProgressColumn,
    workspaces: mockWorkspaces,
    projectSlug: 'my-project',
  },
};

export const Hidden: Story = {
  name: 'Hidden (renders null)',
  args: {
    column: inProgressColumn,
    workspaces: mockWorkspaces,
    projectSlug: 'my-project',
    isHidden: true,
  },
};

export const PROpenColumn: Story = {
  args: {
    column: prOpenColumn,
    workspaces: [
      {
        ...baseWorkspace,
        id: 'ws-pr-1',
        name: 'Feature A',
        prUrl: 'https://github.com/example/repo/pull/100',
        prNumber: 100,
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        kanbanColumn: 'PR_OPEN',
      },
      {
        ...baseWorkspace,
        id: 'ws-pr-2',
        name: 'Feature B',
        prUrl: 'https://github.com/example/repo/pull/101',
        prNumber: 101,
        prState: 'OPEN',
        prCiStatus: 'SUCCESS',
        kanbanColumn: 'PR_OPEN',
      },
    ],
    projectSlug: 'my-project',
  },
};

export const AllColumns: Story = {
  decorators: [
    () => (
      <div className="flex gap-4 overflow-x-auto p-4">
        {KANBAN_COLUMNS.slice(0, 4).map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            workspaces={
              column.id === 'IN_PROGRESS'
                ? mockWorkspaces.slice(0, 2)
                : column.id === 'BACKLOG'
                  ? [mockWorkspaces[2]]
                  : []
            }
            projectSlug="demo"
          />
        ))}
      </div>
    ),
  ],
  args: {
    column: inProgressColumn,
    workspaces: [],
    projectSlug: 'demo',
  },
};
