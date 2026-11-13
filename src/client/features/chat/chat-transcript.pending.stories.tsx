import type { Meta, StoryObj } from '@storybook/react';
import { type ComponentProps, useState } from 'react';
import { expect, within } from 'storybook/test';
import { createUserMessage } from '@/lib/claude.fixture';
import type { ChatTranscript } from './chat-transcript';
import {
  StartupPreview,
  chatTranscriptMeta,
  startupMessage,
} from './chat-transcript.story-fixtures';

const meta: Meta<typeof ChatTranscript> = {
  ...chatTranscriptMeta,
  title: 'Chat/Transcript/ChatTranscript',
};

export default meta;
type Story = StoryObj<typeof meta>;

export const QueuedDuringInitScript: Story = {
  render: (args) => <StartupPreview {...args} />,
  args: {
    messages: [startupMessage],
    queuedMessageIds: new Set([startupMessage.id]),
    onRemoveQueuedMessage: () => undefined,
    initBanner: {
      kind: 'info',
      message: 'Running init script...',
      showRetry: false,
      showPlay: false,
      showDismiss: false,
    },
  },
};

export const QueuedDuringSessionLoading: Story = {
  ...QueuedDuringInitScript,
  args: { ...QueuedDuringInitScript.args, initBanner: null },
};

export const QueuedDuringAgentStartup: Story = {
  ...QueuedDuringSessionLoading,
  args: {
    ...QueuedDuringSessionLoading.args,
    loadingSession: false,
    startingSession: true,
  },
};

export const QueuedMessageSteering: Story = {
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story: 'Queued messages use a steering wheel icon for the Steer action.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const steer = canvas.getByRole('button', { name: 'Steer queued message' });
    const cancel = canvas.getByRole('button', { name: 'Cancel queued message' });
    const steerBox = steer.getBoundingClientRect();
    const cancelBox = cancel.getBoundingClientRect();
    await expect(steerBox.height).toBe(24);
    await expect(cancelBox.height).toBe(steerBox.height);
    await expect(cancelBox.y).toBe(steerBox.y);
    const icon = cancel.querySelector('svg')!.getBoundingClientRect();
    await expect(
      Math.abs(icon.x + icon.width / 2 - cancelBox.x - cancelBox.width / 2)
    ).toBeLessThan(1);
    await expect(
      Math.abs(icon.y + icon.height / 2 - cancelBox.y - cancelBox.height / 2)
    ).toBeLessThan(1);
  },
  render: (args) => <StartupPreview {...args} />,
  args: {
    messages: [startupMessage],
    queuedMessageIds: new Set([startupMessage.id]),
    onRemoveQueuedMessage: () => undefined,
    onSteerQueuedMessage: () => undefined,
    running: true,
    loadingSession: false,
    work: {
      promptInFlight: true,
      backgroundTasks: [],
      runningSubagents: 0,
      activeGoals: 0,
    },
  },
};

export const QueuedMessageSteeringPending: Story = {
  ...QueuedMessageSteering,
  args: {
    ...QueuedMessageSteering.args,
    pendingSteerMessageId: startupMessage.id,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const steer = canvas.getByRole('button', { name: 'Steering queued message' });
    await expect(steer).toBeDisabled();
    await expect(steer).toHaveTextContent('Steering…');
    await expect(steer).toHaveAttribute('aria-busy', 'true');
  },
};

function QueueHandoffPreview(args: ComponentProps<typeof ChatTranscript>) {
  const [queued, setQueued] = useState(true);
  return (
    <div className="h-full flex flex-col">
      <button
        type="button"
        className="self-start text-sm underline mb-2"
        onClick={() => setQueued(!queued)}
      >
        {queued ? 'Dequeue message' : 'Queue message again'}
      </button>
      <div className="flex-1 min-h-0">
        <StartupPreview
          {...args}
          queuedMessageIds={queued ? new Set([startupMessage.id]) : new Set()}
          onSteerQueuedMessage={() => setQueued(false)}
        />
      </div>
    </div>
  );
}

export const QueuedMessageHandoff: Story = {
  ...QueuedMessageSteering,
  render: (args) => <QueueHandoffPreview {...args} />,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        story:
          'Dequeue or steer to preview the controls collapsing while the message stays mounted. Respects reduced motion.',
      },
    },
  },
};

const queuedCommand = createUserMessage('/compact');
export const QueuedCommandWithoutActions: Story = {
  render: (args) => <StartupPreview {...args} />,
  args: {
    messages: [queuedCommand],
    queuedMessageIds: new Set([queuedCommand.id]),
    onSteerQueuedMessage: () => undefined,
    loadingSession: false,
    running: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          'A queued command without a cancel callback reserves no space for ineligible steering controls.',
      },
    },
  },
};

export const PhoneQueuedMessageHandoff: Story = {
  ...QueuedMessageHandoff,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** Attachment bytes are already local; no server acknowledgement is needed to render. */
export const SendingImage: Story = {
  args: {
    sessionId: 'sending-story',
    loadingSession: false,
    pendingMessages: new Map([
      [
        'pending-image',
        {
          text: 'Can you explain this image?',
          sessionId: 'sending-story',
          attachments: [
            {
              id: 'image',
              name: 'example.png',
              type: 'image/png',
              size: 68,
              contentType: 'image',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            },
          ],
        },
      ],
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Can you explain this image?')).toBeVisible();
    await expect(canvas.getByText('Sending…')).toBeVisible();
  },
};

export const SendingWhileReconnecting: Story = {
  ...SendingImage,
  args: { ...SendingImage.args, loadingSession: true },
};
