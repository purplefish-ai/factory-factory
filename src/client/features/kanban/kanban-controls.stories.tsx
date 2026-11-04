import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { KanbanControlsView } from './kanban-controls';

/**
 * Board header actions, shown in the app header's right slot. "New Workspace"
 * opens the board's inline form in the Todo column and stays on the board; the
 * sidebar action of the same name opens the created workspace instead.
 */
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
    await userEvent.click(canvas.getByRole('button', { name: 'New workspace' }));
    await expect(args.onNewWorkspace).toHaveBeenCalledOnce();
    await expect(canvas.queryByRole('button', { name: 'New Task' })).not.toBeInTheDocument();
  },
};

/** Phones keep the header compact with an icon-only button and the same accessible name. */
export const Mobile: Story = {
  args: { isMobile: true },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
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
    await expect(
      within(canvasElement).getByRole('button', { name: 'Refresh workspaces' })
    ).toBeDisabled();
  },
};
