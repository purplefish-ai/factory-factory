import type { Meta, StoryObj } from '@storybook/react';
import { useRef } from 'react';
import { VirtualizedMessageList } from '@/client/features/chat/virtualized-message-list';
import { PRUpdateRenderer } from './pr-update-renderer';

const meta = { title: 'Chat/PR update', component: PRUpdateRenderer } satisfies Meta<
  typeof PRUpdateRenderer
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Delivered: Story = {
  args: {
    text: '<!-- factory-factory-pr-event:example -->\nPR #12 · CI failed\nhttps://github.com/org/repo/pull/12\nCheck: unit tests',
  },
};
export const Queued: Story = {
  args: { text: 'PR update queued for the next turn', queued: true },
};

function ConversationPreview({ updateCount = 1 }: { updateCount?: number }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const updates = Array.from({ length: updateCount }, (_, index) => ({
    id: `pr-event-queued-story-${index}`,
    source: 'user' as const,
    order: index,
    timestamp: '2026-10-28T00:00:00.000Z',
    text: 'PR update queued for the next turn',
  }));
  return (
    <div ref={scrollContainerRef} className="h-80 w-full max-w-3xl overflow-auto border rounded-md">
      <VirtualizedMessageList
        messages={updates}
        queuedMessageIds={new Set(updates.map(({ id }) => id))}
        running
        startingSession={false}
        loadingSession={false}
        latestThinking="Considering the implementation and checking the existing components."
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
}

export const QueuedBelowThinking: StoryObj<typeof ConversationPreview> = {
  parameters: { controls: { disable: true } },
  render: () => <ConversationPreview />,
};

export const MultipleQueuedUpdates: StoryObj<typeof ConversationPreview> = {
  parameters: { controls: { disable: true } },
  render: () => <ConversationPreview updateCount={3} />,
};

export const Failed: Story = {
  args: {
    ...Delivered.args,
    deliveryState: 'failed',
    error: 'Provider unavailable. PR updates are paused.',
  },
};
export const Cancelled: Story = { args: { ...Delivered.args, deliveryState: 'cancelled' } };
