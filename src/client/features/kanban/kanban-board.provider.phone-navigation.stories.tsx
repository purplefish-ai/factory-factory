import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { KanbanBoard } from './kanban-board';
import { handlers, kanbanBoardMeta, workspaces } from './kanban-board.provider.story-fixtures';

const meta = {
  ...kanbanBoardMeta,
  title: 'Board/KanbanBoardWithData',
} satisfies Meta<typeof KanbanBoard>;
export default meta;
type Story = StoryObj<typeof meta>;

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
    // Only the 16px bottom padding remains below Done. The maximum scrollTop is
    // whole pixels while card heights can sum to a half pixel, so allow < 1px.
    await expect(
      scroll.getBoundingClientRect().bottom - done.getBoundingClientRect().bottom
    ).toBeLessThan(17);
  },
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
