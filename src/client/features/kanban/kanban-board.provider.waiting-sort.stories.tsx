import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { readStorageItem, removeStorageItem } from '@/client/lib/browser-storage';
import { KanbanBoard } from './kanban-board';
import { handlers, kanbanBoardMeta } from './kanban-board.provider.story-fixtures';
import { baseWorkspace } from './kanban-card.story-fixtures';

const meta = {
  ...kanbanBoardMeta,
  title: 'Board/KanbanBoardWithData',
} satisfies Meta<typeof KanbanBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingSort: Story = {
  beforeEach: () => {
    removeStorageItem('kanban-waiting-sort-order');
    return () => removeStorageItem('kanban-waiting-sort-order');
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
    await expect(readStorageItem('kanban-waiting-sort-order')).toBe('created');
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
