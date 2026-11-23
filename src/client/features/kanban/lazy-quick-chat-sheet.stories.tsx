import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { QuickChatFallbackSheet } from './lazy-quick-chat-sheet';

const meta = {
  title: 'Board/QuickChatFallbackSheet',
  component: QuickChatFallbackSheet,
  args: { open: true, title: 'Fix login redirect', onClose: fn() },
} satisfies Meta<typeof QuickChatFallbackSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The first open on a board, while the chat chunk downloads. */
export const Loading: Story = {};

/** The chat chunk failed to load, usually after a deploy replaced it. */
export const LoadFailed: Story = { args: { failed: true } };
