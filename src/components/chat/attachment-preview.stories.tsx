import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import type { MessageAttachment } from '@/lib/claude-types';
import { AttachmentPreview } from './attachment-preview';

// Sample base64 image (1x1 red pixel PNG)
const SAMPLE_IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Sample text content
const SAMPLE_TEXT_SHORT = `function hello() {
  console.log("Hello, world!");
}`;

const SAMPLE_TEXT_LONG = `import React from 'react';

interface Props {
  name: string;
  age: number;
}

export function UserCard({ name, age }: Props) {
  return (
    <div className="card">
      <h2>{name}</h2>
      <p>Age: {age}</p>
    </div>
  );
}

export default UserCard;`;

// Sample attachments
const imageAttachment: MessageAttachment = {
  id: 'img-1',
  name: 'screenshot.png',
  type: 'image/png',
  size: 1024 * 50, // 50KB
  data: SAMPLE_IMAGE_DATA,
  contentType: 'image',
};

const textAttachmentShort: MessageAttachment = {
  id: 'txt-1',
  name: 'Pasted text (3 lines)',
  type: 'text/plain',
  size: SAMPLE_TEXT_SHORT.length,
  data: SAMPLE_TEXT_SHORT,
  contentType: 'text',
};

const textAttachmentLong: MessageAttachment = {
  id: 'txt-2',
  name: 'user-card.tsx',
  type: 'text/plain',
  size: SAMPLE_TEXT_LONG.length,
  data: SAMPLE_TEXT_LONG,
  contentType: 'text',
};

const onRemoveAction = fn();

const meta: Meta<typeof AttachmentPreview> = {
  title: 'Chat/AttachmentPreview',
  component: AttachmentPreview,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    readOnly: {
      control: 'boolean',
      description: 'Hide remove button (for display-only mode)',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl p-4 bg-background border rounded-lg">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ImageAttachment: Story = {
  args: {
    attachments: [imageAttachment],
    onRemove: onRemoveAction,
  },
};

export const TextAttachment: Story = {
  args: {
    attachments: [textAttachmentShort],
    onRemove: onRemoveAction,
  },
};

export const TextAttachmentFile: Story = {
  args: {
    attachments: [textAttachmentLong],
    onRemove: onRemoveAction,
  },
};

export const MultipleImages: Story = {
  args: {
    attachments: [
      imageAttachment,
      { ...imageAttachment, id: 'img-2', name: 'diagram.png' },
      { ...imageAttachment, id: 'img-3', name: 'architecture-overview.png' },
    ],
    onRemove: onRemoveAction,
  },
};

export const MultipleTextFiles: Story = {
  args: {
    attachments: [
      textAttachmentShort,
      textAttachmentLong,
      {
        ...textAttachmentLong,
        id: 'txt-3',
        name: 'config.json',
      },
    ],
    onRemove: onRemoveAction,
  },
};

export const MixedAttachments: Story = {
  args: {
    attachments: [imageAttachment, textAttachmentShort, textAttachmentLong],
    onRemove: onRemoveAction,
  },
};

export const ReadOnly: Story = {
  args: {
    attachments: [imageAttachment, textAttachmentLong],
    readOnly: true,
  },
};

export const Empty: Story = {
  args: {
    attachments: [],
    onRemove: onRemoveAction,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-sm font-medium mb-2">Image Attachment</h3>
        <AttachmentPreview attachments={[imageAttachment]} onRemove={onRemoveAction} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Text Attachment (Pasted Text)</h3>
        <AttachmentPreview attachments={[textAttachmentShort]} onRemove={onRemoveAction} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Text Attachment (File)</h3>
        <AttachmentPreview attachments={[textAttachmentLong]} onRemove={onRemoveAction} />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Mixed Attachments</h3>
        <AttachmentPreview
          attachments={[imageAttachment, textAttachmentShort, textAttachmentLong]}
          onRemove={onRemoveAction}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Read Only (No Remove Button)</h3>
        <AttachmentPreview attachments={[imageAttachment, textAttachmentLong]} readOnly />
      </div>
    </div>
  ),
};
