import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent } from 'storybook/test';
import type { KanbanColumn as KanbanColumnType } from '@/shared/core';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.stories';
import { getKanbanColumns, KanbanColumn } from './kanban-column';
import { KanbanFamilyProvider } from './kanban-family-highlight';

/**
 * Note: The actual KanbanBoard component cannot be fully tested in Storybook
 * because it depends on the KanbanProvider context with tRPC hooks.
 *
 * These stories demonstrate the visual layout using KanbanColumn components directly.
 * The ISSUES column requires tRPC and is not shown in these stories.
 * WorkspacesBoardView remounts the provider and board when projectId changes,
 * clearing dialogs, Quick Chat, forms and the initial mobile tab selection.
 * Project-switch lifecycle and delayed archive responses are covered by
 * workspaces-board-view.test.tsx using the real provider and board.
 */

// =============================================================================
// Mock Data
// =============================================================================

const mockWorkspaces: WorkspaceWithKanban[] = [
  {
    ...baseWorkspace,
    id: 'ws-1',
    kanbanColumn: 'WORKING',
    name: 'Add authentication',
    isWorking: true,
  },
  { ...baseWorkspace, id: 'ws-2', kanbanColumn: 'WORKING', name: 'Fix login bug', status: 'NEW' },
  {
    ...baseWorkspace,
    id: 'ws-3',
    kanbanColumn: 'WAITING',
    name: 'Update dependencies',
    prNumber: 42,
    prUrl: '#',
    prState: 'OPEN',
  },
  {
    ...baseWorkspace,
    id: 'ws-4',
    kanbanColumn: 'WAITING',
    name: 'Add dark mode',
    prNumber: 43,
    prUrl: '#',
    prState: 'APPROVED',
  },
  {
    ...baseWorkspace,
    id: 'ws-5',
    kanbanColumn: 'DONE',
    name: 'Fix typo',
    prNumber: 40,
    prUrl: '#',
    prState: 'MERGED',
  },
];

// Only workspace columns (not ISSUES which requires tRPC)
const WORKSPACE_COLUMNS = getKanbanColumns('GITHUB').filter((col) => col.id !== 'ISSUES');

function groupByColumn(workspaces: WorkspaceWithKanban[]) {
  const grouped: Record<KanbanColumnType, WorkspaceWithKanban[]> = {
    WORKING: [],
    WAITING: [],
    DONE: [],
  };
  for (const ws of workspaces) {
    const col = ws.kanbanColumn as KanbanColumnType;
    if (col in grouped) {
      grouped[col].push(ws);
    }
  }
  return grouped;
}

// =============================================================================
// Mock Board Component for Storybook
// =============================================================================

function MockKanbanBoard({ workspaces }: { workspaces: WorkspaceWithKanban[] }) {
  const grouped = groupByColumn(workspaces);
  return (
    <KanbanFamilyProvider workspaces={workspaces}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {WORKSPACE_COLUMNS.map((column) => (
          <KanbanColumn
            key={column.id}
            column={column}
            workspaces={grouped[column.id as KanbanColumnType] ?? []}
            projectSlug="demo"
          />
        ))}
      </div>
    </KanbanFamilyProvider>
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

export const FamilyAcrossColumns: Story = {
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>('[data-workspace-id="child"]')!;
    await userEvent.hover(card);
    await expect(canvasElement.querySelectorAll('[data-family-highlighted="true"]')).toHaveLength(
      3
    );
    await userEvent.unhover(card);
    await expect(canvasElement.querySelectorAll('[data-family-highlighted="true"]')).toHaveLength(
      0
    );
    const parentCard = canvasElement.querySelector('[data-workspace-id="parent"]')!;
    const controls = parentCard.querySelector(
      'button[aria-label="Navigate workspace family"]'
    )!.parentElement!;
    const rect = controls.getBoundingClientRect();
    const hit = canvasElement.ownerDocument.elementFromPoint(
      rect.right - 3,
      rect.top + rect.height / 2
    );
    await expect(hit?.closest('a')?.getAttribute('href')).toBe('/projects/demo/workspaces/parent');
  },
  args: {
    workspaces: [
      {
        ...baseWorkspace,
        id: 'parent',
        name: 'Authentication refactor',
        kanbanColumn: 'WAITING',
        childWorkspaceCount: 2,
      },
      {
        ...baseWorkspace,
        id: 'child',
        name: 'Add token refresh',
        creationSource: 'CHILD_WORKSPACE',
        kanbanColumn: 'WORKING',
        isWorking: true,
        parentWorkspace: {
          id: 'parent',
          name: 'Authentication refactor',
          projectId: 'proj-1',
          projectName: 'Demo',
          projectSlug: 'demo',
        },
      },
      {
        ...baseWorkspace,
        id: 'sibling',
        name: 'Auth regression tests',
        creationSource: 'CHILD_WORKSPACE',
        kanbanColumn: 'DONE',
        parentWorkspace: {
          id: 'parent',
          name: 'Authentication refactor',
          projectId: 'proj-1',
          projectName: 'Demo',
          projectSlug: 'demo',
        },
      },
      { ...baseWorkspace, id: 'other', name: 'Unrelated billing task', kanbanColumn: 'WORKING' },
    ],
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

export const AllWorking: Story = {
  args: {
    workspaces: [
      { ...baseWorkspace, id: 'ws-1', name: 'Task 1', kanbanColumn: 'WORKING', isWorking: true },
      { ...baseWorkspace, id: 'ws-2', name: 'Task 2', kanbanColumn: 'WORKING', isWorking: true },
      { ...baseWorkspace, id: 'ws-3', name: 'Task 3', kanbanColumn: 'WORKING', status: 'NEW' },
      {
        ...baseWorkspace,
        id: 'ws-4',
        name: 'Task 4',
        kanbanColumn: 'WORKING',
        status: 'PROVISIONING',
      },
    ],
  },
};

export const WithArchivedWorkspaces: Story = {
  args: {
    workspaces: [
      ...mockWorkspaces,
      {
        ...baseWorkspace,
        id: 'ws-archived-1',
        name: 'Archived task',
        kanbanColumn: 'WAITING',
        status: 'ARCHIVED',
      },
      {
        ...baseWorkspace,
        id: 'ws-archived-2',
        name: 'Another archived',
        kanbanColumn: 'DONE',
        status: 'ARCHIVED',
        prState: 'MERGED',
      },
    ],
  },
};
