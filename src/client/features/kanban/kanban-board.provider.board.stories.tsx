import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { STORY_TRPC_PENDING } from '@/client/lib/storybook-trpc';
import type { KanbanBoard } from './kanban-board';
import { handlers, kanbanBoardMeta } from './kanban-board.provider.story-fixtures';

const meta = {
  ...kanbanBoardMeta,
  title: 'Board/KanbanBoardWithData',
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

export const PhoneDark: Story = {
  ...Phone,
  globals: { theme: 'dark', viewport: { value: 'phone', isRotated: false } },
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
    // The form opens while this story's draft store is still restoring; focus
    // must land in the same commit that enables the field.
    await waitFor(() => expect(input).toBeEnabled());
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

export const ArchiveDoneColumn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Archive All' }));
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('archive all 1 workspace in this column');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  },
};
