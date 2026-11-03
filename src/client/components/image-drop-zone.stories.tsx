import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { AttachmentPreview } from '@/client/features/composer/attachment-preview';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { ImageDropZone } from './image-drop-zone';

function DropExample({
  destination,
  disabled = false,
}: {
  destination: 'workspace' | 'message';
  disabled?: boolean;
}) {
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [formOpen, setFormOpen] = useState(destination === 'message');
  return (
    <div className="h-[520px] bg-background p-4 text-foreground">
      <ImageDropZone
        dropIdentity={destination}
        disabled={disabled}
        label={
          destination === 'workspace'
            ? 'Drop images to attach to a new workspace'
            : 'Drop images to attach to your message'
        }
        onDropAccepted={() => setFormOpen(true)}
        onAttachments={(added) => setAttachments((previous) => [...previous, ...added])}
      >
        <div className="flex h-full flex-col gap-4 rounded-xl border p-4">
          <h2 className="font-semibold">
            {destination === 'workspace' ? 'Kanban board' : 'Workspace conversation'}
          </h2>
          <p className="flex-1 text-sm text-muted-foreground">
            Drag image files anywhere in this view.
          </p>
          {formOpen && (
            <div className="space-y-3 rounded-lg border bg-card p-3">
              <p className="text-sm font-medium">
                {destination === 'workspace' ? 'New workspace' : 'Message'}
              </p>
              <textarea
                className="w-full rounded-md border bg-background p-2 text-sm"
                placeholder="Add instructions…"
              />
              <AttachmentPreview
                attachments={attachments}
                onRemove={(id) =>
                  setAttachments((previous) =>
                    previous.filter((attachment) => attachment.id !== id)
                  )
                }
              />
            </div>
          )}
        </div>
      </ImageDropZone>
    </div>
  );
}

const meta = {
  title: 'Composer/ImageDropZone',
  component: DropExample,
  parameters: { layout: 'fullscreen' },
  args: { destination: 'message' },
} satisfies Meta<typeof DropExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Message: Story = {};
export const NewWorkspace: Story = { args: { destination: 'workspace' } };
export const Disabled: Story = { args: { disabled: true } };

const showDropIndicator: NonNullable<Story['play']> = ({ canvasElement }) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File(['image'], 'reference.png', { type: 'image/png' }));
  canvasElement
    .querySelector('textarea, h2')
    ?.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
};
export const MessageDropIndicator: Story = { play: showDropIndicator };
export const NewWorkspaceDropIndicator: Story = {
  args: { destination: 'workspace' },
  play: showDropIndicator,
};
