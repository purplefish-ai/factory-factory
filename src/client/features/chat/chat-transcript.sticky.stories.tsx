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
    const pinned = await canvas.findByRole('button', { name: /Back to your message:/ });
    await expect(pinned).toBeVisible();
    await expect(pinned.querySelector('.truncate')).toHaveStyle({ whiteSpace: 'nowrap' });
    await userEvent.click(pinned);
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: /Back to your message:/ })).toBeNull()
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
      within(canvasElement).queryByRole('button', { name: /Back to your message:/ })
    ).toBeNull();
  },
};

const earlierPrompt = createUserMessage('Explain the earlier layout changes.');
const laterPrompt = createUserMessage('Now check the current scroll behavior.');
const conversation = [
  earlierPrompt,
  ...Array.from({ length: 16 }, (_, i) =>
    createAssistantMessage(
      `Earlier response ${i + 1}: ${'The layout keeps the conversation readable. '.repeat(4)}`
    )
  ),
  laterPrompt,
  ...Array.from({ length: 16 }, (_, i) =>
    createAssistantMessage(
      `Current response ${i + 1}: ${'Checking the scroll position and context. '.repeat(4)}`
    )
  ),
];

export const ReadingEarlierRequest: Story = {
  args: { loadingSession: false, messages: conversation },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('transcript-viewport');
    await expect(
      await canvas.findByRole('button', {
        name: `Back to your message: ${laterPrompt.text}`,
      })
    ).toBeVisible();
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: /Back to your message:/ })).toBeNull()
    );
    await canvas.findByText(earlierPrompt.text ?? '');
    const row = viewport.querySelector(`[data-transcript-key="${earlierPrompt.id}"]`);
    if (!row) {
      throw new Error('The earlier request must be mounted at the start of the conversation');
    }
    const end =
      row.getBoundingClientRect().bottom -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop;
    viewport.scrollTop = end + 8;
    viewport.dispatchEvent(new Event('scroll'));
    await expect(canvas.queryByRole('button', { name: /Back to your message:/ })).toBeNull();
    viewport.scrollTop = end + 56;
    viewport.dispatchEvent(new Event('scroll'));
    const pinned = await canvas.findByRole('button', {
      name: `Back to your message: ${earlierPrompt.text}`,
    });
    await expect(pinned).toBeVisible();
    await userEvent.click(pinned);
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: /Back to your message:/ })).toBeNull()
    );
    await expect(canvas.getByText(earlierPrompt.text ?? '')).toBeVisible();
  },
};

export const ReadingEarlierRequestPhone: Story = {
  ...ReadingEarlierRequest,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const ApproachingNextRequest: Story = {
  args: { loadingSession: false, messages: conversation },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('transcript-viewport');
    await userEvent.click(
      await canvas.findByRole('button', {
        name: `Back to your message: ${laterPrompt.text}`,
      })
    );
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: /Back to your message:/ })).toBeNull()
    );
    await canvas.findByText(laterPrompt.text ?? '');
    const row = viewport.querySelector(`[data-transcript-key="${laterPrompt.id}"]`);
    if (!row) {
      throw new Error('Jumping to the next request must mount its row');
    }
    const start =
      row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -60 }));
    viewport.scrollTop = start - 60;
    viewport.dispatchEvent(new Event('scroll'));
    const pinned = await canvas.findByRole('button', {
      name: `Back to your message: ${earlierPrompt.text}`,
    });
    await expect(pinned.getBoundingClientRect().bottom).toBeLessThan(
      row.getBoundingClientRect().top
    );
    viewport.scrollTop = start - 20;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: /Back to your message:/ })).toBeNull()
    );
    await expect(canvas.getByText(laterPrompt.text ?? '')).toBeVisible();
  },
};

export const ApproachingNextRequestPhone: Story = {
  ...ApproachingNextRequest,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
