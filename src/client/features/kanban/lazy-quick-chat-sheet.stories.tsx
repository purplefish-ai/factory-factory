import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { QuickChatSheetFrame, QuickChatUnavailable } from './lazy-quick-chat-sheet';

const meta = {
  title: 'Board/QuickChatSheetFrame',
  component: QuickChatSheetFrame,
  args: {
    open: true,
    title: 'Fix login redirect',
    onClose: fn(),
    children: <QuickChatUnavailable />,
  },
} satisfies Meta<typeof QuickChatSheetFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The first open on a board, while the chat chunk downloads. */
export const Loading: Story = {};

/** The chat chunk failed to load, usually after a deploy replaced it, or the body crashed. */
export const Unavailable: Story = { args: { children: <QuickChatUnavailable failed /> } };
