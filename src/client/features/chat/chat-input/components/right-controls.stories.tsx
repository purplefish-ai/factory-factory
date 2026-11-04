import type { Meta, StoryObj } from '@storybook/react';
import { createRef } from 'react';
import { expect, fn, within } from 'storybook/test';
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
