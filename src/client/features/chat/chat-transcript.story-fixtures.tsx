import type { Meta } from '@storybook/react';
import type { ComponentProps } from 'react';
import { createUserMessage } from '@/lib/claude-fixtures';
import { ChatTranscript } from './chat-transcript';

/**
 * Meta shared by the `Chat/Transcript/ChatTranscript` story files. Each file
 * sets its own literal `title` because Storybook's indexer reads it statically.
 */
export const chatTranscriptMeta: Meta<typeof ChatTranscript> = {
  component: ChatTranscript,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="h-96 bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    messages: [],
    running: false,
    startingSession: false,
    loadingSession: true,
    scroll: {
      identity: 'story',
      active: true,
      ready: true,
      initialIntent: 'following',
      initialPosition: null,
    },
  },
};

export const startupMessage = createUserMessage(
  'Please fix the failing tests and explain what changed.'
);

export function StartupPreview(props: ComponentProps<typeof ChatTranscript>) {
  return (
    <div className="h-full overflow-auto">
      <ChatTranscript
        {...props}
        scroll={{
          identity: 'story',
          active: true,
          ready: true,
          initialIntent: 'following',
          initialPosition: null,
        }}
      />
    </div>
  );
}
