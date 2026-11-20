import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { ProviderNoticeRenderer } from './provider-notice-renderer';

const meta = {
  title: 'Chat/Transcript/ProviderNoticeRenderer',
  component: ProviderNoticeRenderer,
  parameters: { layout: 'padded' },
  args: {
    notice: {
      id: 'retry',
      revision: 2,
      provider: 'CODEX',
      severity: 'warning',
      category: 'connection',
      title: 'Reconnecting... 2/5',
    },
  },
} satisfies Meta<typeof ProviderNoticeRenderer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Reconnecting: Story = {
  args: { notice: { ...meta.args.notice, reconnect: 'retrying' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(
      'Codex is reconnecting · Attempt 2 of 5'
    );
  },
};

export const Reconnected: Story = {
  args: { notice: { ...meta.args.notice, reconnect: 'recovered' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Codex reconnected');
  },
};

export const RetryEnded: Story = {
  args: { notice: { ...meta.args.notice, reconnect: 'ended' } },
};

export const Interrupted: Story = {
  args: {
    notice: {
      id: 'interrupted',
      revision: 0,
      provider: 'CLAUDE',
      severity: 'info',
      title: 'Request interrupted',
    },
  },
};
