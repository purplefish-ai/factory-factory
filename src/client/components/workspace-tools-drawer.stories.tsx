import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { WorkspaceToolsFixture } from '@/client/routes/workspace-tools-fixture';

const meta = {
  title: 'Workspace/MobileToolsDrawer',
  component: WorkspaceToolsFixture,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        foldClosed: { name: 'Fold closed', styles: { width: '344px', height: '882px' } },
        foldOpen: { name: 'Fold unfolded', styles: { width: '800px', height: '720px' } },
      },
    },
  },
  globals: { viewport: { value: 'foldClosed', isRotated: false } },
} satisfies Meta<typeof WorkspaceToolsFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Changes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Open tools' }));
    await expect(await canvas.findByRole('dialog', { name: 'Workspace tools' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Changes' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Terminal' })).toBeVisible();
  },
};
export const Terminal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Open tools' }));
    const drawer = await canvas.findByRole('dialog', { name: 'Workspace tools' });
    const tools = within(drawer).getByRole('navigation', { name: 'Workspace tools' });
    const terminal = within(tools).getByRole('button', { name: 'Terminal' });
    await userEvent.click(terminal);
    await expect(terminal).toHaveAttribute('aria-pressed', 'true');
  },
};

export const UnfoldedChanges: Story = {
  ...Changes,
  globals: { viewport: { value: 'foldOpen', isRotated: false } },
};
