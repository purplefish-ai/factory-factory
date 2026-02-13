import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { QueuedMessage } from '@/lib/chat-protocol';
import { QueuedMessages } from './queued-messages';

const meta = {
  title: 'Chat/QueuedMessages',
  component: QueuedMessages,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl border rounded">
        <Story />
      </div>
    ),
  ],
  args: {
    onRemove: fn(),
  },
} satisfies Meta<typeof QueuedMessages>;

export default meta;
type Story = StoryObj<typeof meta>;

const defaultSettings = {
  selectedModel: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};

const mockMessages: QueuedMessage[] = [
  {
    id: '1',
    text: 'Fix the type error in auth.ts',
    timestamp: new Date().toISOString(),
    settings: defaultSettings,
  },
  {
    id: '2',
    text: 'Then add tests for the new login flow',
    timestamp: new Date().toISOString(),
    settings: defaultSettings,
  },
  {
    id: '3',
    text: 'Also update the README with the new API endpoints',
    timestamp: new Date().toISOString(),
    settings: defaultSettings,
  },
];

export const Empty: Story = {
  name: 'Empty (renders null)',
  args: {
    messages: [],
  },
};

export const SingleMessage: Story = {
  args: {
    messages: [mockMessages[0]!],
  },
};

export const MultipleMessages: Story = {
  args: {
    messages: mockMessages,
  },
};

export const LongMessage: Story = {
  args: {
    messages: [
      {
        id: '1',
        text: 'This is a very long message that should be truncated when it exceeds the container width to show an ellipsis instead of wrapping to multiple lines',
        timestamp: new Date().toISOString(),
        settings: defaultSettings,
      },
    ],
  },
};

export const ManyMessages: Story = {
  args: {
    messages: [
      {
        id: '1',
        text: 'First task: review the PR',
        timestamp: new Date().toISOString(),
        settings: defaultSettings,
      },
      {
        id: '2',
        text: 'Second task: fix merge conflicts',
        timestamp: new Date().toISOString(),
        settings: defaultSettings,
      },
      {
        id: '3',
        text: 'Third task: run tests',
        timestamp: new Date().toISOString(),
        settings: defaultSettings,
      },
      {
        id: '4',
        text: 'Fourth task: update changelog',
        timestamp: new Date().toISOString(),
        settings: defaultSettings,
      },
      {
        id: '5',
        text: 'Fifth task: deploy to staging',
        timestamp: new Date().toISOString(),
        settings: defaultSettings,
      },
    ],
  },
};
