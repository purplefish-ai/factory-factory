import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { ChatInput } from './chat-input/chat-input';

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

// Resolved Claude capabilities, as the session runtime reports them once the
// agent is ready. Without them the composer shows its loading state.
const CLAUDE_CAPABILITIES: ChatBarCapabilities = {
  ...EMPTY_CHAT_BAR_CAPABILITIES,
  provider: 'CLAUDE',
  model: {
    enabled: true,
    selected: 'sonnet',
    options: [
      { value: 'sonnet', label: 'Sonnet 5' },
      { value: 'opus', label: 'Opus 4.8' },
    ],
  },
  planMode: { enabled: true },
  attachments: { enabled: true, kinds: ['image', 'text'] },
  slashCommands: { enabled: true },
};

// No-op function for composite stories
function noop(_text: string): void {
  // Intentionally empty - used for visual-only stories
}

const meta: Meta<typeof ChatInput> = {
  title: 'Chat/Input/ChatInput',
  component: ChatInput,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    capabilities: CLAUDE_CAPABILITIES,
  },
  argTypes: {
    disabled: {
      control: 'boolean',
      description: 'Whether the input is disabled (connecting state)',
    },
    running: {
      control: 'boolean',
      description: 'Whether the session has active work, including background processes',
    },
    promptInFlight: {
      control: 'boolean',
      description: 'Whether a prompt is in flight, so the next message will be queued',
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

export const RestoredDraft: Story = {
  args: {
    onSend: onSendAction,
    value: 'Please finish the change I was describing before reloading.',
  },
  render: (args) => {
    const [draft, setDraft] = useState(args.value ?? '');
    return <ChatInput {...args} value={draft} onChange={setDraft} />;
  },
};

export const Disabled: Story = {
  args: {
    onSend: onSendAction,
    disabled: true,
  },
};

/** Before the agent reports its capabilities, model controls show a loading state. */
export const LoadingCapabilities: Story = {
  args: {
    onSend: onSendAction,
    capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
  },
};

export const Running: Story = {
  args: {
    onSend: onSendAction,
    running: true,
    promptInFlight: true,
    placeholder: 'Message will be queued…',
  },
};

export const BackgroundProcessRunning: Story = {
  args: {
    onSend: onSendAction,
    running: true,
    promptInFlight: false,
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
          <ChatInput onSend={noop} capabilities={CLAUDE_CAPABILITIES} inputRef={defaultRef} />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">Disabled (Connecting)</h3>
          <ChatInput
            onSend={noop}
            capabilities={CLAUDE_CAPABILITIES}
            disabled
            inputRef={disabledRef}
          />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">Running (Loading)</h3>
          <ChatInput
            onSend={noop}
            capabilities={CLAUDE_CAPABILITIES}
            running
            inputRef={runningRef}
          />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2">Custom Placeholder</h3>
          <ChatInput
            onSend={noop}
            capabilities={CLAUDE_CAPABILITIES}
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
            <li>Paste large text (20+ lines or 2000+ characters)</li>
            <li>Drag and drop an image file</li>
            <li>Drag and drop a text file (.txt, .md, .js, etc.)</li>
            <li>Drop images and text together; valid files stay attached if another file fails</li>
            <li>The file picker accepts images only</li>
          </ul>
        </div>
        <ChatInput
          onSend={() => {
            setAttachments([]);
          }}
          inputRef={inputRef}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          capabilities={CLAUDE_CAPABILITIES}
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

export const RuntimeError: Story = {
  args: {
    onSend: onSendAction,
    placeholder: "Couldn't continue this chat. Type a message to retry…",
  },
};

export const AcpWithImageUpload: Story = {
  args: {
    onSend: onSendAction,
    acpConfigOptions: [
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ],
    onSetConfigOption: fn(),
  },
};

export const SavedCodexAccount: Story = {
  args: {
    onSend: onSendAction,
    codexAccountId: 'work-account',
    capabilities: {
      ...EMPTY_CHAT_BAR_CAPABILITIES,
      provider: 'CODEX',
      usageStats: { enabled: true, contextWindow: true },
      model: {
        enabled: true,
        selected: 'gpt-6.1-sol',
        options: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
      },
    },
  },
};

export const NativePlanningShortcut: Story = {
  args: {
    onSend: onSendAction,
    onSettingsChange: fn(),
    onSetConfigOption: fn(),
  },
  render: (args) => {
    const [mode, setMode] = useState('default');
    return (
      <ChatInput
        {...args}
        acpConfigOptions={[
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: mode,
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
            ],
          },
        ]}
        onSetConfigOption={(id, value) => {
          args.onSetConfigOption?.(id, value);
          setMode(value);
        }}
      />
    );
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox'));
    await userEvent.keyboard('[AltLeft>][ShiftLeft>][KeyP][/ShiftLeft][/AltLeft]');
    await expect(args.onSetConfigOption).toHaveBeenLastCalledWith('mode', 'plan');
    await userEvent.keyboard('[AltLeft>][ShiftLeft>][KeyP][/ShiftLeft][/AltLeft]');
    await expect(args.onSetConfigOption).toHaveBeenLastCalledWith('mode', 'default');
    await expect(args.onSettingsChange).not.toHaveBeenCalled();
  },
};
