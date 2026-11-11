import type { Meta, StoryObj } from '@storybook/react';
import { createRef } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { formatShortcut } from '@/client/lib/keyboard-shortcuts';
import { RightControls } from './input-controls';

const meta = {
  title: 'Chat/Input/SendControls',
  component: RightControls,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="flex w-[min(32rem,calc(100vw-2rem))] rounded-lg border p-2">
        <Story />
      </div>
    ),
  ],
  args: {
    pendingMessageCount: 1,
    running: true,
    stopping: true,
    disabled: true,
    onSendClick: fn(),
    inputRef: createRef<HTMLTextAreaElement>(),
  },
} satisfies Meta<typeof RightControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SendingAndStopping: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Sending…')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  },
};
export const SendingAndStoppingDark: Story = { ...SendingAndStopping, globals: { theme: 'dark' } };

export const StopShortcut: Story = {
  args: { stopping: false, disabled: false, pendingMessageCount: 0 },
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: 'Stop agent' }));
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole('tooltip')
    ).toHaveTextContent(`Stop agent (${formatShortcut('composer.stop')})`);
  },
};
/** A pending Stop is disabled but still explains itself and its shortcut on hover. */
export const StopShortcutWhileStopping: Story = {
  args: { stopping: true, disabled: false, pendingMessageCount: 0 },
  play: async ({ canvasElement }) => {
    const stop = within(canvasElement).getByRole('button', { name: 'Stopping…' });
    await expect(stop).toBeDisabled();
    // A disabled button takes no pointer events; its wrapper opens the tooltip.
    await userEvent.hover(stop.parentElement as HTMLElement);
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole('tooltip')
    ).toHaveTextContent(`Stop agent (${formatShortcut('composer.stop')})`);
  },
};
export const ReadyToSend: Story = {
  args: { running: false, stopping: false, disabled: false, pendingMessageCount: 0 },
  play: async ({ canvasElement }) => {
    const send = within(canvasElement).getByRole('button', { name: 'Send message' });
    await expect(send).toHaveAttribute('data-variant', 'default');
    await userEvent.hover(send);
    await expect(send).toBeVisible();
  },
};
export const ReadyToSendDark: Story = { ...ReadyToSend, globals: { theme: 'dark' } };
export const ReadyToQueue: Story = {
  ...ReadyToSend,
  args: { ...ReadyToSend.args, promptInFlight: true },
  play: async ({ canvasElement }) => {
    const queue = within(canvasElement).getByRole('button', { name: 'Queue message' });
    await expect(queue).toHaveAttribute('data-variant', 'default');
    await userEvent.hover(queue);
  },
};
