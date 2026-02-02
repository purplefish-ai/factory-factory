import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { fn } from 'storybook/test';

import type { MessageAttachment } from '@/lib/claude-types';
import { ChatInput } from './chat-input';

// Action handler for Storybook
const onSendAction = fn();

// Sample base64 image (1x1 red pixel PNG)
const SAMPLE_IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Sample attachments
const sampleImageAttachment: MessageAttachment = {
  id: 'img-1',
  name: 'screenshot.png',
  type: 'image/png',
  size: 1024 * 50,
  data: SAMPLE_IMAGE_DATA,
  contentType: 'image',
};

const sampleTextAttachment: MessageAttachment = {
  id: 'txt-1',
  name: 'Pasted text (15 lines)',
  type: 'text/plain',
  size: 500,
  data: 'function example() {\n  return "Hello";\n}',
  contentType: 'text',
};

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

export const WithImageAttachment: Story = {
  args: {
    onSend: onSendAction,
    attachments: [sampleImageAttachment],
    onAttachmentsChange: fn(),
  },
};

export const WithTextAttachment: Story = {
  args: {
    onSend: onSendAction,
    attachments: [sampleTextAttachment],
    onAttachmentsChange: fn(),
  },
};

export const WithMixedAttachments: Story = {
  args: {
    onSend: onSendAction,
    attachments: [sampleImageAttachment, sampleTextAttachment],
    onAttachmentsChange: fn(),
  },
};

/**
 * Interactive story to test drag and drop / paste behavior.
 * Try pasting an image or large text, or drag files into the input.
 */
export const InteractivePasteDrop: Story = {
  render: () => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const [attachments, setAttachments] = useState<MessageAttachment[]>([]);

    return (
      <div className="flex flex-col gap-4 w-full max-w-2xl">
        <div className="text-sm text-muted-foreground">
          <p className="font-medium mb-2">Test Instructions:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Paste an image (Cmd/Ctrl+V after copying an image)</li>
            <li>Paste large text (10+ lines or 1000+ characters)</li>
            <li>Drag and drop an image file</li>
            <li>Drag and drop a text file (.txt, .md, .js, etc.)</li>
          </ul>
        </div>
        <ChatInput
          onSend={() => {
            setAttachments([]);
          }}
          inputRef={inputRef}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          placeholder="Try pasting or dropping files here..."
        />
        {attachments.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Attachments: {attachments.map((a) => a.name).join(', ')}
          </div>
        )}
      </div>
    );
  },
};
