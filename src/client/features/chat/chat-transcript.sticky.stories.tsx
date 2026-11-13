import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createAssistantMessage, createUserMessage } from '@/lib/claude.fixture';
import type { ChatTranscript } from './chat-transcript';
import { chatTranscriptMeta } from './chat-transcript.story-fixtures';

const meta: Meta<typeof ChatTranscript> = {
  ...chatTranscriptMeta,
  title: 'Chat/Transcript/ChatTranscript',
};
export default meta;
type Story = StoryObj<typeof meta>;

const prompt = createUserMessage(
  'Keep the latest user message visible while I read the agent’s progress.\nClick the pinned preview to return to this full request.'
);

export const StickyLatestUserMessage: Story = {
  args: {
    loadingSession: false,
    messages: [
      prompt,
      ...Array.from({ length: 24 }, (_, i) =>
        createAssistantMessage(
          `Progress update ${i + 1}: checking the conversation layout and scroll behavior.`,
          i + 1
        )
      ),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pinned = await canvas.findByRole('button', { name: /Back to your latest message:/ });
    await expect(pinned).toBeVisible();
    await expect(pinned.querySelector('.truncate')).toHaveStyle({ whiteSpace: 'nowrap' });
    await userEvent.click(pinned);
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: /Back to your latest message:/ })).toBeNull()
    );
    await expect(
      await canvas.findByText(/Click the pinned preview to return to this full request/)
    ).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Scroll to bottom' })).toBeVisible();
  },
};

export const StickyLatestUserMessagePhone: Story = {
  ...StickyLatestUserMessage,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const LatestUserMessageInView: Story = {
  args: { loadingSession: false, messages: [prompt] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole('button', { name: /Back to your latest message:/ })
    ).toBeNull();
  },
};
