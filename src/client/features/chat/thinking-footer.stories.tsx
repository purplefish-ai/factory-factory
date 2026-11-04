import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ThinkingFooter } from './thinking-footer';

const meta = {
  title: 'Chat/Transcript/ThinkingFooter',
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

export const MultipleParagraphs: Story = {
  args: {
    latestThinking: '**Preparing PR body**\n\n**Waiting 60 seconds**\n\n**Checking** `CI`',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = canvas.getByRole('button', { name: 'Show thinking preview' });
    await expect(preview).toHaveTextContent('Checking CI');
    await expect(preview).not.toHaveTextContent('Preparing PR body');
    await userEvent.click(preview);
    const popup = within(canvasElement.ownerDocument.body).getByLabelText('Thinking preview');
    await expect(popup).toHaveTextContent('Preparing PR body');
    await expect(popup).toHaveTextContent('Waiting 60 seconds');
    await expect(popup).toHaveTextContent('Checking CI');
    await expect(popup).not.toHaveTextContent('**');
  },
};

export const PartialMarkdown: Story = {
  args: { latestThinking: '**Previous step**\n\n**Checking the latest' },
};

export const TrailingMarkers: Story = {
  args: { latestThinking: '**Checking CI**\n\n**' },
};

export const FencedCode: Story = {
  args: { latestThinking: '**Inspecting output**\n\n```text\nuser_id\n\n---\n```' },
};

export const IdentifiersAndBullets: Story = {
  args: {
    latestThinking:
      '**Checking** user_id and MAX_RETRY_COUNT\n\n* inspect `__init__`\n* keep a*b*c',
  },
};

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
    const preview = canvas.getByRole('button', { name: 'Show thinking preview' });
    preview.focus();
    await expect(preview).toHaveFocus();
    canvas.getByRole('button', { name: 'Toggle activity' }).click();
    // Focus leaves the disabled preview once React commits the inactive state.
    await waitFor(() => expect(footer.contains(document.activeElement)).toBe(false));
    await expect(preview).toBeDisabled();
    await expect(preview).not.toHaveFocus();
    await expect(footer.getBoundingClientRect().height).toBe(height);
  },
};

export const WaitingForApproval: Story = {
  args: { waitingFor: 'permission_request' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Waiting for your approval');
    await expect(canvas.queryByRole('button', { name: 'Show thinking preview' })).toBeNull();
  },
};
export const WaitingForAnswer: Story = { args: { waitingFor: 'user_question' } };
export const WaitingForPlanApproval: Story = { args: { waitingFor: 'plan_approval' } };
export const WaitingForApprovalDark: Story = {
  args: { waitingFor: 'permission_request' },
  globals: { theme: 'dark' },
};
