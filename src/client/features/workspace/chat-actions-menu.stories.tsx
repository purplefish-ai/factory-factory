import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ChatActionsMenu } from './chat-actions-menu';

const meta = {
  title: 'Workspace/ChatActionsMenu',
  component: ChatActionsMenu,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The ⋮ menu at the right of the chat tab bar. It holds Restart agent, a recovery action that used to be an always-visible button.',
      },
    },
  },
  args: { chatLabel: 'Chat 2', onRestartSession: fn(), onRename: fn() },
} satisfies Meta<typeof ChatActionsMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Restart: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Chat actions' }));
    const menu = within(await within(canvasElement.ownerDocument.body).findByRole('menu'));
    await expect(menu.getByText('Chat 2')).toBeVisible();
    await userEvent.click(menu.getByRole('menuitem', { name: /Restart agent/ }));
    await expect(args.onRestartSession).toHaveBeenCalled();
  },
};

export const Busy: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Chat actions' }));
    const menu = within(await within(canvasElement.ownerDocument.body).findByRole('menu'));
    await expect(menu.getByRole('menuitem', { name: /Restart agent/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Rename: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Chat actions' }));
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole('menuitem', { name: 'Rename chat' }));
    await expect(args.onRename).toHaveBeenCalled();
  },
};
