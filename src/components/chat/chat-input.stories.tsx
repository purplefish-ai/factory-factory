import type { Meta, StoryObj } from '@storybook/react';
import { useRef } from 'react';
import { fn } from 'storybook/test';

import { ChatInput } from './chat-input';

// Action handler for Storybook
const onSendAction = fn();

// No-op function for composite stories
function noop(_text: string): void {
  // Intentionally empty - used for visual-only stories
}

const meta: Meta<typeof ChatInput> = {
  title: 'Chat/ChatInput',
  component: ChatInput,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    disabled: {
      control: 'boolean',
      description: 'Whether the input is disabled (connecting state)',
    },
    running: {
      control: 'boolean',
      description: 'Whether a request is currently running',
    },
    placeholder: {
      control: 'text',
      description: 'Placeholder text for the input',
    },
  },
  decorators: [
    (Story, context) => {
      const inputRef = useRef<HTMLTextAreaElement>(null);
      return (
        <div className="w-full max-w-2xl">
          <Story args={{ ...context.args, inputRef }} />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    onSend: onSendAction,
  },
};

export const Disabled: Story = {
  args: {
    onSend: onSendAction,
    disabled: true,
  },
};

export const Running: Story = {
  args: {
    onSend: onSendAction,
    running: true,
  },
};

export const WithPlaceholder: Story = {
  args: {
    onSend: onSendAction,
    placeholder: 'Ask me anything about your code...',
  },
};

export const AllStates: Story = {
  args: {
    onSend: noop,
  },
  render: () => {
    const defaultRef = useRef<HTMLTextAreaElement>(null);
    const disabledRef = useRef<HTMLTextAreaElement>(null);
    const runningRef = useRef<HTMLTextAreaElement>(null);

    return (
      <div className="flex flex-col gap-6 w-full max-w-2xl">
        <div>
          <h3 className="text-sm font-medium mb-2">Default</h3>
          <ChatInput onSend={noop} inputRef={defaultRef} />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">Disabled (Connecting)</h3>
          <ChatInput onSend={noop} disabled inputRef={disabledRef} />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">Running (Loading)</h3>
          <ChatInput onSend={noop} running inputRef={runningRef} />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">Custom Placeholder</h3>
          <ChatInput
            onSend={noop}
            placeholder="Ask me anything about your code..."
            inputRef={useRef<HTMLTextAreaElement>(null)}
          />
        </div>
      </div>
    );
  },
};
