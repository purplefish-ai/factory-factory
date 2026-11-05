import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { AppHeader } from '@/client/components/app-header';
import {
  AppHeaderProvider,
  HeaderLeftStartSlot,
  HeaderRightSlot,
} from '@/client/components/app-header-context';
import {
  IssueRefreshRecoveryFixture,
  exerciseIssueRefreshRecovery,
} from '@/client/components/project-issues-recovery.story-fixtures';
import { STORY_TRPC_PENDING, type StoryTrpcHandlers } from '@/client/lib/storybook-trpc';
import { useIsMobile } from '@/hooks/use-mobile';
import { IssueProvider } from '@/shared/core/enums';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';
import { KanbanProvider } from './kanban-context';
import { KanbanControls } from './kanban-controls';
import { KanbanToolbar } from './kanban-toolbar';

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

function BoardActions() {
  const isMobile = useIsMobile();
  return isMobile ? (
    <KanbanToolbar />
  ) : (
    <HeaderRightSlot>
      <KanbanControls />
    </HeaderRightSlot>
  );
}

const meta = {
  title: 'Board/KanbanBoardWithData',
  component: KanbanBoard,
  parameters: { layout: 'fullscreen', trpc: { handlers } },
  decorators: [
    (Story) => (
      <AppHeaderProvider>
        <KanbanProvider projectId="proj-1" projectSlug="demo" issueProvider={IssueProvider.GITHUB}>
          <AppHeader showSidebarToggle={false} />
          <HeaderLeftStartSlot>
            <span className="shrink-0 text-sm font-semibold">Board</span>
          </HeaderLeftStartSlot>
          <BoardActions />
          <div className="h-[640px] p-4">
            <Story />
          </div>
        </KanbanProvider>
      </AppHeaderProvider>
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
    // Header actions must not push Waiting/Done below Working or the Todo button.
    const createButton = within(todo).getByRole('button', { name: 'New workspace' });
    const firstItems = [
      createButton,
      ...['ws-1', 'ws-3', 'ws-4'].map((id) => {
        const card = canvasElement.querySelector<HTMLElement>(`[data-workspace-id="${id}"]`);
        if (!card) {
          throw new Error(`Missing card ${id}`);
        }
        return card;
      }),
    ];
    const top = createButton.getBoundingClientRect().top;
    for (const item of firstItems) {
      await expect(Math.abs(item.getBoundingClientRect().top - top)).toBeLessThan(1);
    }
    const headings = canvas.getAllByRole('heading', { level: 3 });
    await expect(headings).toHaveLength(4);
    const headerTop = headings[0]!.getBoundingClientRect().top;
    for (const [index, heading] of headings.entries()) {
      const header = heading.parentElement!.parentElement!;
      const headerBounds = header.getBoundingClientRect();
      await expect(Math.abs(heading.getBoundingClientRect().top - headerTop)).toBeLessThan(1);
      await expect(headerBounds.height).toBe(52);
      await expect(
        Math.abs(
          heading.getBoundingClientRect().left - firstItems[index]!.getBoundingClientRect().left
        )
      ).toBeLessThan(1);
    }
    await userEvent.click(createButton);
    await expect(within(todo).getByPlaceholderText('What should the agent work on?')).toBeVisible();
    await expect(
      within(todo).queryByRole('button', { name: 'New workspace' })
    ).not.toBeInTheDocument();
  },
};

/** Phones show one column at a time behind column pills. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toolbar = canvas.getByRole('toolbar', { name: 'Board toolbar' });
    await expect(within(toolbar).getByRole('button', { name: /^Search$/ })).toBeVisible();
    await expect(within(toolbar).getByRole('button', { name: 'New workspace' })).toHaveTextContent(
      'New workspace'
    );
    await expect(
      canvasElement.querySelector('header')?.querySelector('[aria-label="Search"]')
    ).toBeNull();
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
      '/admin/project?project=demo'
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
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('status', { name: 'Loading issues' })
    ).toBeVisible();
  },
  parameters: {
    trpc: { handlers: { ...handlers, 'github.listIssuesForProject': () => STORY_TRPC_PENDING } },
  },
};

export const NoAssignedIssues: Story = {
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('No assigned issues')).toBeVisible();
  },
  parameters: {
    trpc: {
      handlers: { ...handlers, 'github.listIssuesForProject': () => ({ issues: [], error: null }) },
    },
  },
};

export const FilterOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Add authentication');
    await expect(
      canvas.queryByRole('combobox', { name: 'Sort workspaces' })
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole('checkbox', { name: /^Select / })).not.toBeInTheDocument();
    const filter = within(canvas.getByRole('banner')).getByRole('textbox', {
      name: 'Filter board',
    });
    await userEvent.type(filter, 'authentication');
    await expect(canvas.getByText('Add authentication')).toBeVisible();
    await expect(canvas.queryByText('Fix login bug')).not.toBeInTheDocument();
    await userEvent.clear(filter);
    await userEvent.type(filter, 'keyboard');
    await expect(canvas.getByText('Support keyboard shortcuts on the board')).toBeVisible();
    await expect(canvas.queryByText('Add authentication')).not.toBeInTheDocument();
    await userEvent.clear(filter);
    await expect(canvas.getByText('Add authentication')).toBeVisible();
  },
};

export const PhoneFilter: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const filter = within(canvas.getByRole('banner')).getByRole('textbox', {
      name: 'Filter board',
    });
    await expect(filter).toBeVisible();
    await userEvent.type(filter, 'no matching task');
    await expect(canvas.getByText('No matching issues or workspaces')).toBeVisible();
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Filter board' }));
    await expect(canvas.getByText('Update dependencies')).toBeVisible();
  },
};

export const IssuesRefreshRecovery: Story = {
  render: () => (
    <IssueRefreshRecoveryFixture
      projectId="proj-1"
      handlers={{ 'workspace.listForProject': () => ({ workspaces, reviewCount: 0 }) }}
    >
      <KanbanProvider projectId="proj-1" projectSlug="demo" issueProvider={IssueProvider.GITHUB}>
        <div className="h-[640px] p-4">
          <KanbanBoard />
        </div>
      </KanbanProvider>
    </IssueRefreshRecoveryFixture>
  ),
  play: async ({ canvasElement }) => exerciseIssueRefreshRecovery(canvasElement),
};

export const ArchiveDoneColumn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Archive All' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('archive all 1 workspace in this column');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  },
};

export const WaitingSort: Story = {
  beforeEach: () => {
    localStorage.removeItem('kanban-waiting-sort-order');
    return () => localStorage.removeItem('kanban-waiting-sort-order');
  },
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'workspace.listForProject': () => ({
          workspaces: [
            {
              ...baseWorkspace,
              kanbanColumn: 'WAITING',
              id: 'older-created',
              name: 'Recent message',
              createdAt: new Date('2026-11-01'),
              lastActivityAt: '2026-11-04T12:00:00Z',
            },
            {
              ...baseWorkspace,
              kanbanColumn: 'WAITING',
              id: 'newer-created',
              name: 'Recent creation',
              createdAt: new Date('2026-11-03'),
              lastActivityAt: '2026-11-03T12:00:00Z',
            },
          ],
          reviewCount: 0,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Recent message');
    const ids = () =>
      [...canvasElement.querySelectorAll('[data-workspace-id]')].map((el) =>
        el.getAttribute('data-workspace-id')
      );
    await expect(ids()).toEqual(['older-created', 'newer-created']);
    await expect(canvas.queryByText(/Waiting since/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Waiting sort order' }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('menuitemradio', { name: 'Latest message' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await userEvent.click(body.getByRole('menuitemradio', { name: 'Created' }));
    await expect(ids()).toEqual(['newer-created', 'older-created']);
    await expect(localStorage.getItem('kanban-waiting-sort-order')).toBe('created');
    await userEvent.click(canvas.getByRole('button', { name: 'Waiting sort order' }));
    await expect(body.getByRole('menuitemradio', { name: 'Created' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await userEvent.click(body.getByRole('menuitemradio', { name: 'Latest message' }));
    await expect(ids()).toEqual(['older-created', 'newer-created']);
  },
};

export const PhoneWaitingSort: Story = {
  ...WaitingSort,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async (context) => {
    await WaitingSort.play?.(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('button', { name: 'Waiting sort order' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Waiting' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /Working/ }));
    await expect(
      canvas.queryByRole('button', { name: 'Waiting sort order' })
    ).not.toBeInTheDocument();
  },
};

/** Leave room for app padding on a 320px phone. */
export const NarrowPhoneWaitingSort: Story = {
  ...WaitingSort,
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <div style={{ width: 280, height: '100%' }}>
      <KanbanBoard />
    </div>
  ),
  play: async (context) => {
    await WaitingSort.play?.(context);
    const canvas = within(context.canvasElement);
    const sort = canvas.getByRole('button', { name: 'Waiting sort order' });
    const row = sort.parentElement!;
    const bounds = row.getBoundingClientRect();
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    for (const button of within(row).getAllByRole('button')) {
      const rect = button.getBoundingClientRect();
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      await expect(rect.width).toBeGreaterThan(0);
    }
    await userEvent.click(sort);
    await expect(
      within(context.canvasElement.ownerDocument.body).getByRole('menuitemradio', {
        name: 'Created',
      })
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};
