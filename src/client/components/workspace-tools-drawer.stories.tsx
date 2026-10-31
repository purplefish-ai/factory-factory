import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { WorkspaceToolsFixture } from '@/client/routes/workspace-tools-fixture';

const meta = {
  title: 'Workspace/MobileToolsDrawer',
  component: WorkspaceToolsFixture,
  parameters: { layout: 'fullscreen' },
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
    await userEvent.click(await canvas.findByRole('button', { name: 'Terminal' }));
  },
};
