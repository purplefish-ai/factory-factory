import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { STORY_TRPC_PENDING, type StoryTrpcHandlers } from '@/client/lib/storybook-trpc';
import { IssueProvider } from '@/shared/core/enums';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';
import { KanbanProvider } from './kanban-context';

/**
 * The real KanbanBoard and KanbanProvider, fed by story tRPC handlers rather
 * than a backend. `Board/KanbanBoard` lays out columns directly; these stories
 * cover the responsive board, including the phone column pills.
 */

const workspaces: WorkspaceWithKanban[] = [
  { ...baseWorkspace, id: 'ws-1', kanbanColumn: 'WORKING', name: 'Add authentication' },
  { ...baseWorkspace, id: 'ws-2', kanbanColumn: 'WORKING', name: 'Fix login bug' },
  {
    ...baseWorkspace,
    id: 'ws-3',
    kanbanColumn: 'WAITING',
    name: 'Update dependencies',
    waitingSince: '2026-11-04T12:00:00.000Z',
    prNumber: 42,
    prUrl: '#',
    prState: 'OPEN',
  },
  {
    ...baseWorkspace,
    id: 'ws-4',
    kanbanColumn: 'DONE',
    name: 'Fix typo',
    prNumber: 40,
    prUrl: '#',
    prState: 'MERGED',
  },
];

const handlers: StoryTrpcHandlers = {
  'workspace.listForProject': () => ({ workspaces, reviewCount: 0 }),
  'github.listIssuesForProject': () => ({
    issues: [
      {
        number: 7,
        title: 'Support keyboard shortcuts on the board',
        body: '',
        url: 'https://github.com/purplefish-ai/factory-factory/issues/7',
        state: 'OPEN',
        createdAt: '2026-10-01T12:00:00Z',
        author: { login: 'martin' },
      },
    ],
  }),
};

const meta = {
  title: 'Board/KanbanBoardWithData',
  component: KanbanBoard,
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  decorators: [
    (Story) => (
      <KanbanProvider projectId="proj-1" projectSlug="demo" issueProvider={IssueProvider.GITHUB}>
        <div className="h-[640px] p-4">
          <Story />
        </div>
      </KanbanProvider>
    ),
  ],
} satisfies Meta<typeof KanbanBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Update dependencies')).toBeVisible();
    await expect(canvas.getByText('Add authentication')).toBeVisible();
    const todo = canvasElement.querySelector('[data-todo-column]');
    if (!(todo instanceof HTMLElement)) {
      throw new Error('Todo column is missing');
    }
    await userEvent.click(within(todo).getByRole('button', { name: 'New workspace' }));
    await expect(within(todo).getByPlaceholderText('What should the agent work on?')).toBeVisible();
  },
};

/** Phones show one column at a time behind column pills. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The board opens on the Waiting column.
    await expect(await canvas.findByText('Update dependencies')).toBeVisible();
    await expect(canvas.queryByText('Add authentication')).not.toBeInTheDocument();
  },
};

export const Loading: Story = {
  parameters: {
    trpc: { handlers: { ...handlers, 'workspace.listForProject': () => STORY_TRPC_PENDING } },
  },
};

export const LoadError: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'workspace.listForProject': () => {
          throw new Error('Database is locked');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Couldn't load workspaces. Database is locked")
    ).toBeVisible();
  },
};

export const FirstWorkspace: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'workspace.listForProject': () => ({ workspaces: [], reviewCount: 0 }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Create your first workspace')).toBeVisible();
    await expect(await canvas.findByText('Support keyboard shortcuts on the board')).toBeVisible();
  },
};

export const IssuesDisconnected: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'github.listIssuesForProject': () => ({
          issues: [],
          error: 'Project is not linked to a GitHub repository',
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Connect an issue provider to see assigned issues')
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Project settings' })).toHaveAttribute(
      'href',
      '/projects/demo/settings'
    );
  },
};

export const IssuesError: Story = {
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'github.listIssuesForProject': () => ({ issues: [], error: 'GitHub is unavailable' }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(canvas.getByText('Add authentication')).toBeVisible();
  },
};

export const IssuesLoading: Story = {
  parameters: {
    trpc: { handlers: { ...handlers, 'github.listIssuesForProject': () => STORY_TRPC_PENDING } },
  },
};

export const NoAssignedIssues: Story = {
  parameters: {
    trpc: {
      handlers: { ...handlers, 'github.listIssuesForProject': () => ({ issues: [], error: null }) },
    },
  },
};

export const ArchiveSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('checkbox', { name: 'Select Add authentication' })
    );
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select Update dependencies' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Archive selected' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Archive 2 selected workspaces?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('2 selected');
  },
};

export const PhoneFilter: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Filter board' }), 'no matching task');
    await expect(canvas.getByText('No matching issues or workspaces')).toBeVisible();
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Filter board' }));
    await expect(canvas.getByText('Update dependencies')).toBeVisible();
  },
};
