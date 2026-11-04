import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog';
const meta = {
  title: 'Navigation/KeyboardShortcutsDialog',
  component: KeyboardShortcutsDialog,
  args: {
    open: true,
    onOpenChange: () => undefined,
    environment: { platform: 'mac', runtime: 'browser' },
  },
} satisfies Meta<typeof KeyboardShortcutsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MacBrowser: Story = {
  play: async ({ canvasElement }) => {
    const dialog = within(canvasElement.ownerDocument.body).getByRole('dialog', {
      name: 'Keyboard shortcuts',
    });
    await expect(within(dialog).getByText('Toggle planning mode')).toBeVisible();
    await expect(within(dialog).getByText('Option+Shift+P')).toBeInTheDocument();
  },
};
export const WindowsBrowser: Story = {
  args: { environment: { platform: 'other', runtime: 'browser' } },
};
export const DesktopDark: Story = {
  args: { environment: { platform: 'mac', runtime: 'electron' } },
  globals: { theme: 'dark' },
};
export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };
