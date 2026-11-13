import type { Meta, StoryObj } from '@storybook/react';
import { type ComponentProps, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { createAssistantMessage, createUserMessage } from '@/lib/claude-fixtures';
import { ChatInput } from './chat-input/chat-input';
import { ChatTranscript } from './chat-transcript';
import { chatTranscriptMeta } from './chat-transcript.story-fixtures';
import { useTranscriptSend } from './use-transcript-send';

const meta: Meta<typeof ChatTranscript> = {
  ...chatTranscriptMeta,
  title: 'Chat/Transcript/ChatTranscript',
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortReadingTranscript: Story = {
  parameters: { layout: 'fullscreen' },
  args: {
    loadingSession: false,
    messages: [createAssistantMessage('The focused tests passed.', 1)],
    scroll: {
      identity: 'short-reading',
      active: true,
      ready: true,
      initialIntent: 'reading',
      initialPosition: null,
    },
  },
};

/** Exercise composer growth and clearing next to a scrollable transcript. */
function ComposerScrollPreview(args: ComponentProps<typeof ChatTranscript>) {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState(args.messages);
  const { sendMessage, transcriptScroll } = useTranscriptSend((text) => {
    setMessages((previous) => [...previous, createUserMessage(text, previous.length)]);
    setDraft('');
  }, args.scroll);
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
        <ChatTranscript {...args} messages={messages} scroll={transcriptScroll} />
      </div>
      <ChatInput onSend={sendMessage} value={draft} onChange={setDraft} />
    </div>
  );
}

export const ComposerResizing: Story = {
  render: (args) => <ComposerScrollPreview {...args} />,
  args: {
    loadingSession: false,
    messages: Array.from({ length: 30 }, (_, index) =>
      createUserMessage(`Message ${index}. ${'Scrollable transcript content. '.repeat(6)}`)
    ),
  },
};

export const SendWhileReading: Story = {
  ...ComposerResizing,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('transcript-viewport');
    const gap = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    await waitFor(() => expect(gap()).toBeLessThanOrEqual(1));
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await canvas.findByRole('button', { name: 'Scroll to bottom' });
    await userEvent.type(canvas.getByRole('textbox'), 'Continue from here{Enter}');
    await waitFor(() => expect(gap()).toBeLessThanOrEqual(1));
    await expect(
      canvas.queryByRole('button', { name: 'Scroll to bottom' })
    ).not.toBeInTheDocument();
  },
};

export const SendWhileReadingOnPhone: Story = {
  ...SendWhileReading,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const ScrollButtonOverlay: Story = {
  ...ComposerResizing,
  args: { ...ComposerResizing.args, thinkingInFooter: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('transcript-viewport');
    const footer = canvas.getByTestId('thinking-footer');
    const gap = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    await waitFor(() => expect(gap()).toBeLessThanOrEqual(1));
    const height = viewport.clientHeight;
    const footerTop = footer.getBoundingClientRect().top;
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    const button = await canvas.findByRole('button', { name: 'Scroll to bottom' });
    await expect(viewport.clientHeight).toBe(height);
    await expect(footer.getBoundingClientRect().top).toBe(footerTop);
    const bounds = button.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    await expect(bounds.top).toBeGreaterThanOrEqual(viewportBounds.top);
    await expect(bounds.bottom).toBeLessThanOrEqual(viewportBounds.bottom);
    await userEvent.click(button);
    await waitFor(() => expect(gap()).toBeLessThanOrEqual(1));
    await expect(button).not.toBeInTheDocument();
    await expect(viewport.clientHeight).toBe(height);
  },
};

export const ScrollButtonOverlayOnPhone: Story = {
  ...ScrollButtonOverlay,
  globals: { viewport: { value: 'phone', isRotated: false } },
};
