import type { Meta, StoryObj } from '@storybook/react';
import type { AgentMessage } from '@/lib/chat-protocol';
import { SessionLifecycleMessageRenderer } from './session-lifecycle-message-renderer';

function lifecycleMessage(
  reason: NonNullable<AgentMessage['lifecycle']>['reason'],
  message: string
) {
  return {
    type: 'session_lifecycle',
    lifecycle: {
      eventId: `story-${reason}`,
      kind: 'SESSION_STOPPED',
      reason,
      message,
      timestamp: '2026-07-30T12:22:23.353Z',
    },
  } satisfies AgentMessage;
}

const meta = {
  title: 'AgentActivity/SessionLifecycleMessageRenderer',
  component: SessionLifecycleMessageRenderer,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionLifecycleMessageRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourHourTimeout: Story = {
  args: { message: lifecycleMessage('PROMPT_TIMEOUT', 'Turn stopped: reached the 4-hour limit.') },
};

export const Http529Overload: Story = {
  args: {
    message: lifecycleMessage(
      'PROVIDER_ERROR',
      'Turn stopped: Codex returned HTTP 529 (Overloaded).'
    ),
  },
};

export const ManualStop: Story = {
  args: { message: lifecycleMessage('USER_STOP', 'Session stopped by you.') },
};

export const UnexpectedExit: Story = {
  args: {
    message: lifecycleMessage(
      'UNEXPECTED_EXIT',
      'Session stopped: agent process exited unexpectedly (code 1).'
    ),
  },
};
