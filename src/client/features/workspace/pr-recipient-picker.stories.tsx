import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { PRRecipientPicker } from './pr-recipient-picker';

const meta = {
  title: 'Workspace/PRRecipientPicker',
  component: PRRecipientPicker,
  args: {
    candidates: [
      { id: 'main', name: 'Implementation', provider: 'CLAUDE' },
      { id: 'alternate', name: 'Investigation', provider: 'CODEX' },
    ],
    pending: false,
    onSelect: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof PRRecipientPicker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultipleConversations: Story = {};
export const NoConversation: Story = { args: { candidates: [] } };
export const Pending: Story = {
  args: { pending: true },
  play: async () => {
    const confirm = await within(document.body).findByRole('button', {
      name: 'Enabling PR updates…',
    });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
  },
};
