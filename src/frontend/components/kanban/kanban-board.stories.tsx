import type { KanbanColumn as KanbanColumnType } from '@prisma-gen/browser';
import type { Meta, StoryObj } from '@storybook/react';
import type { WorkspaceWithKanban } from './kanban-card';
import { KANBAN_COLUMNS, KanbanColumn } from './kanban-column';

/**
 * Note: The actual KanbanBoard component cannot be fully tested in Storybook
 * because it depends on the KanbanProvider context with tRPC hooks.
 *
 * These stories demonstrate the visual layout using KanbanColumn components directly.
 */

// =============================================================================
// Mock Data
// =============================================================================

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
  prCiFailedAt: null,
  prCiLastNotifiedAt: null,
  status: 'READY',
  createdAt: new Date(),
  updatedAt: new Date(),
  kanbanColumn: 'IN_PROGRESS',
  isWorking: false,
  initErrorMessage: null,
  initStartedAt: null,
  initCompletedAt: null,
  initRetryCount: 0,
  githubIssueNumber: null,
  githubIssueUrl: null,
  hasHadSessions: true,
  cachedKanbanColumn: 'IN_PROGRESS',
  stateComputedAt: new Date(),
  runScriptCommand: null,
  runScriptCleanupCommand: null,
  runScriptPid: null,
  runScriptPort: null,
  runScriptStartedAt: null,
  runScriptStatus: 'IDLE',
};

const mockWorkspaces: WorkspaceWithKanban[] = [
  { ...baseWorkspace, id: 'ws-1', kanbanColumn: 'BACKLOG', name: 'Research API design' },
  {
    ...baseWorkspace,
    id: 'ws-2',
    kanbanColumn: 'IN_PROGRESS',
    name: 'Add authentication',
    isWorking: true,
  },
  { ...baseWorkspace, id: 'ws-3', kanbanColumn: 'IN_PROGRESS', name: 'Fix login bug' },
  {
    ...baseWorkspace,
    id: 'ws-4',
    kanbanColumn: 'PR_OPEN',
    name: 'Update dependencies',
    prNumber: 42,
    prUrl: '#',
    prState: 'OPEN',
  },
  {
    ...baseWorkspace,
    id: 'ws-5',
    kanbanColumn: 'APPROVED',
    name: 'Add dark mode',
    prNumber: 43,
    prUrl: '#',
    prState: 'APPROVED',
  },
  {
    ...baseWorkspace,
    id: 'ws-6',
    kanbanColumn: 'MERGED',
    name: 'Fix typo',
    prNumber: 40,
    prUrl: '#',
    prState: 'MERGED',
  },
];

function groupByColumn(workspaces: WorkspaceWithKanban[]) {
  const grouped: Record<KanbanColumnType, WorkspaceWithKanban[]> = {
    BACKLOG: [],
    IN_PROGRESS: [],
    WAITING: [],
    PR_OPEN: [],
    APPROVED: [],
    MERGED: [],
    DONE: [],
  };
  for (const ws of workspaces) {
    grouped[ws.kanbanColumn].push(ws);
  }
  return grouped;
}

// =============================================================================
// Mock Board Component for Storybook
// =============================================================================

function MockKanbanBoard({ workspaces }: { workspaces: WorkspaceWithKanban[] }) {
  const grouped = groupByColumn(workspaces);
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {KANBAN_COLUMNS.map((column) => (
        <KanbanColumn
          key={column.id}
          column={column}
          workspaces={grouped[column.id]}
          projectSlug="demo"
        />
      ))}
    </div>
  );
}

// =============================================================================
// Story Meta
// =============================================================================

const meta = {
  title: 'Kanban/KanbanBoard',
  component: MockKanbanBoard,
  parameters: {
    layout: 'fullscreen',
    nextjs: {
      appDirectory: true,
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MockKanbanBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Stories
// =============================================================================

export const WithData: Story = {
  args: {
    workspaces: mockWorkspaces,
  },
};

export const Empty: Story = {
  args: {
    workspaces: [],
  },
};

export const FewWorkspaces: Story = {
  args: {
    workspaces: mockWorkspaces.slice(0, 2),
  },
};

export const AllInProgress: Story = {
  args: {
    workspaces: [
      { ...baseWorkspace, id: 'ws-1', name: 'Task 1', kanbanColumn: 'IN_PROGRESS' },
      { ...baseWorkspace, id: 'ws-2', name: 'Task 2', kanbanColumn: 'IN_PROGRESS' },
      { ...baseWorkspace, id: 'ws-3', name: 'Task 3', kanbanColumn: 'IN_PROGRESS' },
      { ...baseWorkspace, id: 'ws-4', name: 'Task 4', kanbanColumn: 'IN_PROGRESS' },
    ],
  },
};

export const WithHiddenColumns: Story = {
  render: () => {
    const grouped = groupByColumn(mockWorkspaces);
    const hiddenColumns: KanbanColumnType[] = ['DONE', 'MERGED', 'WAITING'];
    return (
      <div className="p-4">
        <div className="flex gap-4 overflow-x-auto pb-4">
          {KANBAN_COLUMNS.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              workspaces={grouped[column.id]}
              projectSlug="demo"
              isHidden={hiddenColumns.includes(column.id)}
            />
          ))}
        </div>
      </div>
    );
  },
  args: {
    workspaces: mockWorkspaces,
  },
};
