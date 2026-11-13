import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AgentErrorStrip } from './agent-error-strip';

const LONG_ERROR = [
  'Turn stopped: Claude returned HTTP 400 (invalid_request_error).',
  '{"type":"error","error":{"type":"invalid_request_error","message":"messages.12.content.3.tool_result: the tool_use_id toolu_01AbCdEf does not match any tool_use block in the previous assistant message."},"request_id":"req_011CXyZ"}',
  ...Array.from(
    { length: 8 },
    (_, index) => `    at AcpRuntime.prompt (runtime.ts:${120 + index}:9)`
  ),
].join('\n');

const meta = {
  title: 'Chat/Input/AgentErrorStrip',
  component: AgentErrorStrip,
  parameters: { layout: 'padded' },
  args: {
    message: 'Turn stopped: Codex returned HTTP 529 (Overloaded).',
    onRetry: fn(),
    onRestart: fn(),
    onDismiss: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl border-t bg-background pb-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentErrorStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderError: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('HTTP 529 (Overloaded)');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Restart agent' }));
    await expect(args.onRestart).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss error' }));
    await expect(args.onDismiss).toHaveBeenCalledTimes(1);
  },
};

export const ProviderErrorDark: Story = {
  globals: { theme: 'dark' },
};

/** Long errors scroll inside the strip so the composer keeps its space. */
export const LongError: Story = {
  args: { message: LONG_ERROR },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByText('Agent error');
    const dismiss = canvas.getByRole('button', { name: 'Dismiss error' });
    await expect(dismiss.getBoundingClientRect().top).toBe(heading.getBoundingClientRect().top);
  },
};

export const LongErrorDark: Story = {
  args: { message: LONG_ERROR },
  globals: { theme: 'dark' },
};

export const LongErrorPhone: Story = {
  args: { message: LONG_ERROR },
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** With nothing to resend (the agent failed to start), only Restart and Copy remain. */
export const StartupFailureWithoutRetry: Story = {
  args: {
    message: 'Failed to start agent: claude-code-acp exited with code 1',
    onRetry: undefined,
  },
};

/** While the restart request is in flight, Restart agent shows a spinner and is disabled. */
export const Restarting: Story = {
  args: { restartPending: true },
  play: async ({ canvasElement }) => {
    const restart = within(canvasElement).getByRole('button', { name: 'Restarting…' });
    await expect(restart).toBeDisabled();
    await expect(restart).toHaveAttribute('aria-busy', 'true');
  },
};

/** Retry is disabled while the chat connection is down. */
export const RetryDisabledOffline: Story = {
  args: { retryDisabled: true },
};
