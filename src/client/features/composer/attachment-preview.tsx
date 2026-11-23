import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { ImageBrokenIcon } from '@phosphor-icons/react/dist/csr/ImageBroken';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useState } from 'react';
import { attachmentImageSrc } from '@/client/lib/chat-images';
import { Button } from '@/components/ui/button';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { formatBytes } from '@/lib/formatters';
import { formatLineCount, isTextAttachment } from '@/lib/image-utils';
import { cn } from '@/lib/utils';
import { AttachmentViewerDialog } from './attachment-viewer-dialog';

interface AttachmentPreviewProps {
  attachments: MessageAttachment[];
  onRemove?: (id: string) => void;
  className?: string;
  /** If true, remove button is hidden (for display-only mode) */
  readOnly?: boolean;
  /** If true, attachments are clickable to view in a dialog */
  clickable?: boolean;
}

/**
 * An image thumbnail in its fixed box. A server reference loads lazily from its
 * immutable URL, which the browser caches; an image this tab sent shows from
 * its own copy.
 */
function AttachmentThumbnail({ attachment }: { attachment: MessageAttachment }) {
  const src = attachmentImageSrc(attachment);
  // Keyed by source, so a new source loads again without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return (
      <ImageBrokenIcon
        role="img"
        aria-label="Image unavailable"
        className="h-6 w-6 text-muted-foreground"
      />
    );
  }
  return (
    <img
      src={src}
      alt={attachment.name}
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
      onError={() => setFailedSrc(src)}
    />
  );
}

/**
 * Preview component for attachments (images and text files) in chat.
 * Shows thumbnails for images, file icons for text, with file info and optional remove button.
 * Displays attachments horizontally with overflow scroll.
 */
export function AttachmentPreview({
  attachments,
  onRemove,
  className,
  readOnly = false,
  clickable = true,
}: AttachmentPreviewProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [selectedAttachment, setSelectedAttachment] = useState<MessageAttachment | null>(null);

  if (attachments.length === 0) {
    return null;
  }

  const handleAttachmentClick = (attachment: MessageAttachment) => {
    if (clickable) {
      setSelectedAttachment(attachment);
      setViewerOpen(true);
    }
  };

  const handleRemove = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onRemove?.(id);
  };

  return (
    <>
      <div className={cn('flex gap-2 overflow-x-auto pb-1', className)}>
        {attachments.map((attachment) => {
          const isText = isTextAttachment(attachment);

          const AttachmentContainer = clickable ? 'button' : 'div';

          return (
            <AttachmentContainer
              key={attachment.id}
              type={clickable ? 'button' : undefined}
              className={cn(
                'relative flex items-center gap-2 rounded-lg border bg-muted/50 p-2 pr-3 transition-colors flex-shrink-0',
                clickable && 'hover:bg-muted/80 cursor-pointer'
              )}
              onClick={() => handleAttachmentClick(attachment)}
              aria-label={clickable ? `View ${attachment.name}` : undefined}
            >
              {/* Thumbnail for images, icon for text */}
              <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded flex items-center justify-center">
                {isText ? (
                  <div className="h-full w-full bg-muted flex items-center justify-center">
                    <FileTextIcon className="h-6 w-6 text-muted-foreground" />
                  </div>
                ) : (
                  <AttachmentThumbnail attachment={attachment} />
                )}
              </div>

              {/* File info */}
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-xs font-medium text-foreground truncate max-w-[150px]">
                  {attachment.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isText
                    ? formatLineCount(attachment.data)
                    : formatBytes(attachment.size, { precision: 1 })}
                </span>
              </div>

              {/* Remove button */}
              {!readOnly && onRemove && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => handleRemove(e, attachment.id)}
                  className="rounded-full hover:bg-destructive/20 hover:text-destructive ml-1"
                  aria-label="Remove attachment"
                >
                  <XIcon />
                </Button>
              )}
            </AttachmentContainer>
          );
        })}
      </div>

      {/* Viewer dialog */}
      <AttachmentViewerDialog
        attachment={selectedAttachment}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
      />
    </>
  );
}
