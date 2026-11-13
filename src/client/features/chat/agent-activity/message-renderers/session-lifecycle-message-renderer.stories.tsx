import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
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
  title: 'Chat/Transcript/SessionLifecycleMessageRenderer',
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

const LONG_PROVIDER_ERROR =
  'Turn stopped: Claude returned HTTP 400 (invalid_request_error): {"type":"error","error":{"type":"invalid_request_error","message":"messages.12.content.3.tool_result: the tool_use_id toolu_01AbCdEf does not match any tool_use block in the previous assistant message. Retry the request with a matching tool_use block."},"request_id":"req_011CXyZ"}';

/** Long provider errors start as one line and expand inline to selectable text. */
export const LongProviderErrorCollapsed: Story = {
  args: { message: lifecycleMessage('PROVIDER_ERROR', LONG_PROVIDER_ERROR) },
};

export const LongProviderErrorExpanded: Story = {
  args: LongProviderErrorCollapsed.args,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Show full error' });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByRole('button', { name: 'Copy error' })).toBeVisible();
    await expect(canvas.getByText(LONG_PROVIDER_ERROR)).not.toHaveClass('truncate');
  },
};

export const LongProviderErrorExpandedDark: Story = {
  ...LongProviderErrorExpanded,
  globals: { theme: 'dark' },
};

export const LongProviderErrorExpandedPhone: Story = {
  ...LongProviderErrorExpanded,
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const LongWarningWrapsPhone: Story = {
  args: {
    message: lifecycleMessage(
      'WORKSPACE_ARCHIVED',
      'Session stopped because the workspace was archived while the agent was still running.'
    ),
  },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const ExpandedTraceAlignment: Story = {
  args: {
    message: lifecycleMessage(
      'PROVIDER_ERROR',
      Array.from({ length: 40 }, (_, line) => `at runtime.ts:${line}`).join('\n')
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show full error' }));
    const heading = canvas.getByText('Error details');
    const collapse = canvas.getByRole('button', { name: 'Collapse error' });
    await expect(collapse.getBoundingClientRect().top).toBe(heading.getBoundingClientRect().top);
  },
};
