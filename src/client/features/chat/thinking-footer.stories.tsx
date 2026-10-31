import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ThinkingFooter } from './thinking-footer';

const meta = {
  title: 'Chat/ThinkingFooter',
  component: ThinkingFooter,
  args: { active: true, latestThinking: 'Inspecting the implementation' },
  decorators: [
    (Story) => (
      <div className="w-full max-w-sm border bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ThinkingFooter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Thinking: Story = {};
export const LongPreview: Story = {
  args: {
    latestThinking:
      'Checking a very long reasoning preview that should never wrap or change the height of the conversation. '.repeat(
        8
      ),
  },
};
export const Idle: Story = { args: { active: false, latestThinking: null } };
export const Dark: Story = { globals: { theme: 'dark' } };

export const ActivityChanges: Story = {
  render: (args) => {
    const [active, setActive] = useState(true);
    const [long, setLong] = useState(false);
    return (
      <>
        <div className="h-40 overflow-auto p-4">Conversation stays still</div>
        <ThinkingFooter
          {...args}
          active={active}
          latestThinking={long ? 'A long thinking preview. '.repeat(40) : 'Checking output'}
        />
        <div className="border-t p-3">Composer</div>
        <button type="button" onClick={() => setLong(!long)}>
          Change thinking
        </button>
        <button type="button" onClick={() => setActive(!active)}>
          Toggle activity
        </button>
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const footer = canvas.getByTestId('thinking-footer');
    const height = footer.getBoundingClientRect().height;
    await userEvent.click(canvas.getByRole('button', { name: 'Change thinking' }));
    await expect(footer.getBoundingClientRect().height).toBe(height);
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle activity' }));
    await expect(footer.getBoundingClientRect().height).toBe(height);
  },
};
