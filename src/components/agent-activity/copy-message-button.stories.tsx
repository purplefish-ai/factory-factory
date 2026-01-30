import type { Meta, StoryObj } from '@storybook/react';
import { CopyMessageButton } from './copy-message-button';

const meta: Meta<typeof CopyMessageButton> = {
  title: 'Components/Agent Activity/CopyMessageButton',
  component: CopyMessageButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof CopyMessageButton>;

export const Default: Story = {
  args: {
    textContent:
      'This is a sample message. Press Ctrl (or Cmd on Mac) to see the copy button appear.',
  },
  decorators: [
    (Story) => (
      <div className="w-96 p-4 border rounded-md bg-background">
        <div className="relative">
          <div className="rounded bg-primary dark:bg-transparent dark:border dark:border-border text-primary-foreground dark:text-foreground px-3 py-2 inline-block max-w-full break-words text-sm text-left whitespace-pre-wrap">
            This is a sample message. Press Ctrl (or Cmd on Mac) to see the copy button appear.
          </div>
          <Story />
        </div>
        <div className="mt-4 text-xs text-muted-foreground">
          💡 Hold Ctrl/Cmd to reveal the copy button
        </div>
      </div>
    ),
  ],
};

export const LongMessage: Story = {
  args: {
    textContent: `This is a much longer message that demonstrates the copy functionality.

It includes multiple lines and paragraphs to show how the copy button works with longer content.

You can copy all of this text by pressing Ctrl (or Cmd on Mac) and clicking the copy button that appears.

The button will show a checkmark for 2 seconds after successfully copying to clipboard.`,
  },
  decorators: [
    (Story) => (
      <div className="w-96 p-4 border rounded-md bg-background">
        <div className="relative">
          <div className="rounded bg-primary dark:bg-transparent dark:border dark:border-border text-primary-foreground dark:text-foreground px-3 py-2 inline-block max-w-full break-words text-sm text-left whitespace-pre-wrap">
            This is a much longer message that demonstrates the copy functionality. It includes
            multiple lines and paragraphs to show how the copy button works with longer content. You
            can copy all of this text by pressing Ctrl (or Cmd on Mac) and clicking the copy button
            that appears. The button will show a checkmark for 2 seconds after successfully copying
            to clipboard.
          </div>
          <Story />
        </div>
        <div className="mt-4 text-xs text-muted-foreground">
          💡 Hold Ctrl/Cmd to reveal the copy button
        </div>
      </div>
    ),
  ],
};

export const AssistantMessage: Story = {
  args: {
    textContent:
      'This represents an assistant message. The copy button works the same way - press Ctrl/Cmd to reveal it.',
  },
  decorators: [
    (Story) => (
      <div className="w-96 p-4 border rounded-md bg-background">
        <div className="relative">
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm break-words">
            <p>
              This represents an assistant message. The copy button works the same way - press
              Ctrl/Cmd to reveal it.
            </p>
          </div>
          <Story />
        </div>
        <div className="mt-4 text-xs text-muted-foreground">
          💡 Hold Ctrl/Cmd to reveal the copy button
        </div>
      </div>
    ),
  ],
};
