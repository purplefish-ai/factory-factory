import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.stories';
import { getKanbanColumns, KanbanColumn } from './kanban-column';

const meta = {
  title: 'Board/KanbanColumn',
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

/** Long words and sentences must leave every card action inside the tile. */
export const LongTitles: Story = {
  args: {
    column: { id: 'DONE', label: 'Done', description: 'PR merged or closed' },
    projectSlug: 'my-project',
    onRename: fn(),
    onOpenQuickChat: fn(),
    onToggleRatcheting: fn(),
    onArchive: fn(),
    workspaces: [
      'project-cmvlbh7la000801s6gcy72l5'.repeat(4),
      'A long workspace title with many words that should wrap across two lines',
      'AgentWorkspaceWithoutAnyWordBreaks'.repeat(4),
    ].map((name, index) => ({
      ...baseWorkspace,
      id: `long-title-${index}`,
      name,
      creationSource: index === 2 ? 'PERIODIC_TASK' : 'MANUAL',
      kanbanColumn: 'DONE',
      prState: 'MERGED',
      statusReason: { code: 'MERGED', label: 'Merged', tone: 'success', needsUser: false },
    })),
  },
  render: (args) => (
    <div className="flex flex-wrap gap-4">
      {[280, 440].map((width) => (
        <div key={width} style={{ width }}>
          <KanbanColumn {...args} />
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const cards = canvasElement.querySelectorAll<HTMLElement>('[data-slot="card"]');
    await expect(cards).toHaveLength(6);
    for (const card of cards) {
      const bounds = card.getBoundingClientRect();
      const title = card.querySelector<HTMLElement>('[data-slot="card-title"]');
      await expect(title).not.toBeNull();
      if (!title) {
        continue;
      }
      await expect(title.getBoundingClientRect().width).toBeGreaterThan(0);
      await expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(
        Number.parseFloat(getComputedStyle(title).lineHeight) * 2 + 1
      );
      for (const button of within(card).getAllByRole('button')) {
        const action = button.getBoundingClientRect();
        await expect(action.left).toBeGreaterThanOrEqual(bounds.left);
        await expect(action.right).toBeLessThanOrEqual(bounds.right);
      }
      await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    }
  },
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
    kanbanColumn: 'WAITING',
  },
  {
    ...baseWorkspace,
    id: 'ws-3',
    name: 'Update dependencies',
    branchName: 'chore/deps',
    isWorking: true,
    kanbanColumn: 'WORKING',
  },
];

// Define columns directly to avoid non-null assertions
const workingColumn = {
  id: 'WORKING' as const,
  label: 'Working',
  description: 'Agent is working',
};
const waitingColumn = {
  id: 'WAITING' as const,
  label: 'Waiting',
  description: 'Waiting for input',
};
const doneColumn = { id: 'DONE' as const, label: 'Done', description: 'PR merged' };

export const Empty: Story = {
  args: {
    column: waitingColumn,
    workspaces: [],
    projectSlug: 'my-project',
  },
};

export const SingleWorkspace: Story = {
  args: {
    column: workingColumn,
    workspaces: [baseWorkspace],
    projectSlug: 'my-project',
  },
};

export const MultipleWorkspaces: Story = {
  args: {
    column: workingColumn,
    workspaces: mockWorkspaces.filter((w) => w.kanbanColumn === 'WORKING'),
    projectSlug: 'my-project',
  },
};

export const WaitingColumn: Story = {
  args: {
    column: waitingColumn,
    workspaces: [
      {
        ...baseWorkspace,
        id: 'ws-wait-1',
        name: 'Feature A',
        prUrl: 'https://github.com/example/repo/pull/100',
        prNumber: 100,
        prState: 'OPEN',
        prCiStatus: 'PENDING',
        kanbanColumn: 'WAITING',
      },
      {
        ...baseWorkspace,
        id: 'ws-wait-2',
        name: 'Feature B',
        prUrl: 'https://github.com/example/repo/pull/101',
        prNumber: 101,
        prState: 'APPROVED',
        prCiStatus: 'SUCCESS',
        kanbanColumn: 'WAITING',
      },
    ],
    projectSlug: 'my-project',
  },
};

export const DoneColumn: Story = {
  args: {
    column: doneColumn,
    workspaces: [
      {
        ...baseWorkspace,
        id: 'ws-done-1',
        name: 'Completed feature',
        prUrl: 'https://github.com/example/repo/pull/99',
        prNumber: 99,
        prState: 'MERGED',
        prCiStatus: 'SUCCESS',
        kanbanColumn: 'DONE',
      },
    ],
    projectSlug: 'my-project',
  },
};

// Workspace columns only (ISSUES requires tRPC)
const WORKSPACE_COLUMNS = getKanbanColumns('GITHUB').filter((col) => col.id !== 'ISSUES');

export const AllColumns: Story = {
  decorators: [
    () => (
      <div className="flex gap-4 overflow-x-auto p-4">
        {WORKSPACE_COLUMNS.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            workspaces={
              column.id === 'WORKING'
                ? mockWorkspaces.filter((w) => w.kanbanColumn === 'WORKING')
                : column.id === 'WAITING'
                  ? mockWorkspaces.filter((w) => w.kanbanColumn === 'WAITING')
                  : []
            }
            projectSlug="demo"
          />
        ))}
      </div>
    ),
  ],
  args: {
    column: workingColumn,
    workspaces: [],
    projectSlug: 'demo',
  },
};

/** The mobile destination after a task is successfully created. */
export const MobileTaskCreated: Story = {
  parameters: { layout: 'fullscreen' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  decorators: [
    (Story) => (
      <div className="w-full max-w-[375px] h-[500px] flex">
        <Story />
      </div>
    ),
  ],
  args: {
    column: workingColumn,
    projectSlug: 'my-project',
    workspaces: [
      createOptimisticWorkspaceSummary({
        id: 'new-task',
        projectId: 'project-1',
        name: 'New task',
        ratchetEnabled: true,
      }),
      { ...baseWorkspace, id: 'existing-task', name: 'Existing task', kanbanColumn: 'WORKING' },
    ],
  },
};
