import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { SessionNameEditor } from './session-name-editor';
const meta = {
  title: 'Workspace/SessionNameEditor',
  component: SessionNameEditor,
  args: { sessionId: 'chat-1', workspaceId: 'workspace-1', name: 'Chat 1', onDone: fn() },
  parameters: { layout: 'centered', trpc: { handlers: { 'session.updateSession': () => ({}) } } },
} satisfies Meta<typeof SessionNameEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Rename: Story = {
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole('textbox', { name: 'Chat name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Review API{Enter}');
    await waitFor(() => expect(args.onDone).toHaveBeenCalled());
  },
};
export const Dark: Story = { globals: { theme: 'dark' } };
export const Phone: Story = { globals: { viewport: { value: 'phone', isRotated: false } } };
export const SaveError: Story = {
  parameters: {
    trpc: {
      handlers: {
        'session.updateSession': () => {
          throw new Error('Disconnected');
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('textbox', { name: 'Chat name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Review API{Enter}');
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole('alert')
    ).toHaveTextContent("Couldn't rename chat.");
    await expect(input).toHaveValue('Review API');
  },
};
