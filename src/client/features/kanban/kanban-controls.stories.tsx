import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { KanbanControlsView } from './kanban-controls';

/** Board overflow menu, with a mobile shortcut to the Todo composer. */
function HeaderPreview(props: Parameters<typeof KanbanControlsView>[0]) {
  return (
    <div className="flex min-h-12 items-center gap-1 border-b bg-background px-2 text-foreground">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">Factory Factory</span>
      <KanbanControlsView {...props} />
    </div>
  );
}

const meta = {
  title: 'Board/KanbanControls',
  component: HeaderPreview,
  parameters: { layout: 'fullscreen' },
  args: {
    isMobile: false,
    isSyncing: false,
    onNewWorkspace: fn(),
    onRefresh: fn(),
  },
} satisfies Meta<typeof HeaderPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'New workspace' })).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole('button', { name: 'Refresh workspaces' })
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Board actions' }));
    await userEvent.click(await within(document.body).findByRole('menuitem', { name: 'Sync now' }));
    await expect(args.onRefresh).toHaveBeenCalledOnce();
  },
};

/** Phones retain a shortcut that opens Todo even when another tab is selected. */
export const Mobile: Story = {
  args: { isMobile: true },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', { name: 'New workspace' });
    await expect(button).toHaveTextContent(/^\s*$/);
    await userEvent.click(button);
    await expect(args.onNewWorkspace).toHaveBeenCalledOnce();
  },
};

export const Syncing: Story = {
  args: { isSyncing: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Board actions' }));
    await expect(
      await within(document.body).findByRole('menuitem', { name: 'Syncing…' })
    ).toHaveAttribute('aria-disabled', 'true');
  },
};
