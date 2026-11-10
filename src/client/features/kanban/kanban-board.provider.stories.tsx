import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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
import { SidebarProvider } from '@/components/ui/sidebar';
import { IssueProvider } from '@/shared/core/enums';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';
import { KanbanProvider } from './kanban-context';
import { KanbanControls } from './kanban-controls';

/**
 * The real KanbanBoard and KanbanProvider, fed by story tRPC handlers rather
 * than a backend. `Board/KanbanBoard` lays out columns directly; these stories
 * cover the responsive board, including the phone column tabs.
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
  return (
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
      <SidebarProvider>
        <div className="flex h-dvh w-full min-w-0 flex-col overflow-hidden md:h-auto md:overflow-visible">
          <AppHeaderProvider>
            <KanbanProvider
              projectId="proj-1"
              projectSlug="demo"
              issueProvider={IssueProvider.GITHUB}
            >
              <AppHeader />
              <HeaderLeftStartSlot>
                <nav
                  aria-label="Breadcrumb"
                  className="flex min-w-0 items-center gap-1 text-sm font-semibold"
                >
                  <span className="truncate">Factory Factory</span>
                  <span aria-hidden className="text-muted-foreground">
                    /
                  </span>
                  <span>Board</span>
                </nav>
              </HeaderLeftStartSlot>
              <BoardActions />
              <div className="h-[calc(100dvh-81px)] min-h-0 p-3 md:h-[640px] md:p-4">
                <Story />
              </div>
            </KanbanProvider>
          </AppHeaderProvider>
        </div>
      </SidebarProvider>
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

/** Phones show one column at a time behind column tabs. */
export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole('banner');
    const search = within(header).getByRole('button', { name: /^Search$/ });
    await expect(search).toBeVisible();
    await expect(within(header).getByRole('button', { name: 'New workspace' })).toBeVisible();
    const filter = await canvas.findByRole('textbox', { name: 'Filter board' });
    await expect(header.contains(filter)).toBe(true);
    await expect(header.querySelector('[data-slot="header-context"]')?.contains(filter)).toBe(
      false
    );
    await expect(search.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      filter.getBoundingClientRect().top
    );
    // Every section stays mounted on mobile.
    await expect(await canvas.findByText('Update dependencies')).toBeVisible();
    await expect(canvas.getByText('Add authentication')).toBeVisible();
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
    const alert = await within(canvasElement).findByRole('alert');
    await expect(alert).toHaveTextContent("Couldn't load workspaces");
    await expect(alert).toHaveTextContent('Database is locked');
    await expect(within(alert).getByRole('button', { name: 'Retry' })).toBeVisible();
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
    const filter = canvas.getByRole('textbox', {
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
            {
              ...baseWorkspace,
              kanbanColumn: 'DONE',
              id: 'done-newer-created',
              name: 'Done with older message',
              createdAt: new Date('2026-11-03'),
              lastActivityAt: '2026-11-03T12:00:00Z',
            },
            {
              ...baseWorkspace,
              kanbanColumn: 'DONE',
              id: 'done-latest-message',
              name: 'Done with latest message',
              createdAt: new Date('2026-11-01'),
              lastActivityAt: '2026-11-04T12:00:00Z',
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
      [...canvasElement.querySelectorAll('[data-workspace-id]')]
        .map((el) => el.getAttribute('data-workspace-id'))
        .filter((id) => !id?.startsWith('done-'));
    const doneIds = () =>
      [...canvasElement.querySelectorAll('[data-workspace-id]')]
        .map((el) => el.getAttribute('data-workspace-id'))
        .filter((id) => id?.startsWith('done-'));
    await expect(doneIds()).toEqual(['done-latest-message', 'done-newer-created']);
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
    await expect(doneIds()).toEqual(['done-latest-message', 'done-newer-created']);
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
    await expect(canvas.getByRole('heading', { name: 'Waiting' })).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: /Working/ }));
    await expect(canvas.getByRole('button', { name: 'Waiting sort order' })).toBeInTheDocument();
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

export const PhoneSectionNavigation: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const navigation = canvas.getByRole('navigation', { name: 'Board sections' });
    const links = within(navigation).getAllByRole('link');
    await expect(links).toHaveLength(4);
    const widths = links.map((link) => link.getBoundingClientRect().width);
    for (const width of widths) {
      await expect(Math.abs(width - widths[0]!)).toBeLessThan(1);
    }
    const scroll = canvasElement.querySelector<HTMLElement>('[data-mobile-board]')!;
    scroll.scrollTop = scroll.scrollHeight;
    await waitFor(async () => {
      const lastCard = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-4"]')!;
      await expect(
        scroll.getBoundingClientRect().bottom - lastCard.getBoundingClientRect().bottom
      ).toBeLessThanOrEqual(32);
    });
    for (const link of links) {
      await userEvent.click(link);
      await waitFor(() => expect(link).toHaveAttribute('aria-current', 'location'));
      const section = canvasElement.ownerDocument.getElementById(
        link.getAttribute('href')!.slice(1)
      )!;
      const desiredTop =
        scroll.scrollTop +
        section.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        navigation.offsetHeight -
        12;
      await expect(
        Math.abs(
          scroll.scrollTop -
            Math.min(Math.max(0, desiredTop), scroll.scrollHeight - scroll.clientHeight)
        )
      ).toBeLessThanOrEqual(1);
      await expect(section.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        navigation.getBoundingClientRect().bottom
      );
    }
    await expect(canvas.getByRole('heading', { name: 'Done' })).toBeVisible();
    await expect(canvas.getByText('Add authentication')).toBeInTheDocument();
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(within(navigation).getByRole('link', { name: 'Todo 1' })).toHaveAttribute(
        'aria-current',
        'location'
      )
    );
  },
};

/** A reduced scrollport, as when the software keyboard takes screen space. */
export const PhoneShortViewport: Story = {
  ...PhoneSectionNavigation,
  render: () => (
    <div className="h-[300px]">
      <KanbanBoard />
    </div>
  ),
};

export const PhoneEmptyDone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    trpc: {
      handlers: {
        ...handlers,
        'workspace.listForProject': () => ({
          workspaces: workspaces.filter((workspace) => workspace.kanbanColumn !== 'DONE'),
          reviewCount: 0,
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const scroll = canvasElement.querySelector<HTMLElement>('[data-mobile-board]')!;
    scroll.scrollTop = scroll.scrollHeight;
    const done = canvas.getByRole('region', { name: 'Done' });
    await expect(done.getBoundingClientRect().height).toBeLessThan(160);
    await expect(
      scroll.getBoundingClientRect().bottom - done.getBoundingClientRect().bottom
    ).toBeLessThanOrEqual(16);
  },
};

export const PhoneFilterAcrossColumns: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const filter = canvas.getByRole('textbox', { name: 'Filter board' });
    await userEvent.type(filter, 'fix');
    await expect(await canvas.findByText('Fix login bug')).toBeVisible();
    await expect(canvas.getByText('Fix typo')).toBeVisible();
    await expect(canvas.queryByText('Update dependencies')).not.toBeInTheDocument();
    await expect(canvas.getByRole('heading', { name: 'Working' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Done' })).toBeVisible();
    await userEvent.clear(filter);
    await expect(await canvas.findByText('Update dependencies')).toBeVisible();
    await expect(canvas.getByText('Fix login bug')).toBeInTheDocument();
  },
};

export const PhoneNewWorkspaceFromDone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const navigation = canvas.getByRole('navigation', { name: 'Board sections' });
    await userEvent.click(within(navigation).getByRole('link', { name: 'Done 1' }));
    await userEvent.click(canvas.getByRole('button', { name: 'New workspace' }));
    const input = await canvas.findByPlaceholderText('What should the agent work on?');
    await expect(input).toHaveFocus();
    await userEvent.type(input, 'Keep my task');
    await userEvent.click(within(navigation).getByRole('link', { name: 'Done 1' }));
    await expect(input).toHaveValue('Keep my task');
    await userEvent.click(canvas.getByRole('button', { name: 'New workspace' }));
    await expect(input).toHaveValue('Keep my task');
    await expect(input.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      navigation.getBoundingClientRect().bottom
    );
    const scroll = canvasElement.querySelector<HTMLElement>('[data-mobile-board]')!;
    await expect(input.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroll.getBoundingClientRect().bottom
    );
  },
};

export const PhoneDark: Story = {
  ...Phone,
  globals: { theme: 'dark', viewport: { value: 'phone', isRotated: false } },
};

/** Card controls must scroll behind the sticky section navigation. */
export const PhoneScrolledControls: Story = {
  // A short scrollport lets a card reach the sticky nav without artificial tail space.
  render: () => (
    <div className="h-[300px]">
      <KanbanBoard />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Update dependencies');
    const navigation = canvas.getByRole('navigation', { name: 'Board sections' });
    const scroll = canvasElement.querySelector<HTMLElement>('[data-mobile-board]')!;
    const card = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-1"]')!;
    const control = within(card).getByRole('button', { name: 'Rename workspace' });
    // Put the control's center at the navigation's center, as during a scroll.
    scroll.scrollTop +=
      control.getBoundingClientRect().top +
      control.getBoundingClientRect().height / 2 -
      (navigation.getBoundingClientRect().top + navigation.getBoundingClientRect().height / 2);
    await waitFor(async () => {
      const box = control.getBoundingClientRect();
      const hit = canvasElement.ownerDocument.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2
      );
      await expect(navigation.contains(hit)).toBe(true);
    });
    for (const link of within(navigation).getAllByRole('link')) {
      const badge = link.querySelector('[data-slot="badge"]')!;
      await expect(badge).not.toBeNull();
      await expect(getComputedStyle(badge).borderTopWidth).toBe('1px');
      await expect(getComputedStyle(badge).borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
    }
    await userEvent.click(within(navigation).getByRole('link', { name: 'Done 1' }));
    await expect(canvas.getByRole('region', { name: 'Done' })).toHaveFocus();
  },
};
