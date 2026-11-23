import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { ImageBrokenIcon } from '@phosphor-icons/react/dist/csr/ImageBroken';
import { useState } from 'react';
import { attachmentImageSrc } from '@/client/lib/chat-images';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { formatBytes } from '@/lib/formatters';
import { formatLineCount, isTextAttachment } from '@/lib/image-utils';

interface AttachmentViewerDialogProps {
  attachment: MessageAttachment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function FullSizeImage({ attachment }: { attachment: MessageAttachment }) {
  const src = attachmentImageSrc(attachment);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ImageBrokenIcon className="h-5 w-5" aria-hidden="true" />
        Image unavailable
      </p>
    );
  }
  const { width, height } = attachment.ref ?? {};
  return (
    <img
      src={src}
      alt={attachment.name}
      decoding="async"
      width={width}
      height={height}
      className="h-auto max-w-full max-h-[70vh] object-contain rounded-lg"
      onError={() => setFailedSrc(src)}
    />
  );
}

/**
 * Dialog for viewing attachment content in full size.
 * Shows images at full resolution or text content in a scrollable area.
 */
export function AttachmentViewerDialog({
  attachment,
  open,
  onOpenChange,
}: AttachmentViewerDialogProps) {
  if (!attachment) {
    return null;
  }

  const isText = isTextAttachment(attachment);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isText && <FileTextIcon className="h-5 w-5 text-muted-foreground" />}
            {attachment.name}
          </DialogTitle>
          <DialogDescription>
            {isText
              ? formatLineCount(attachment.data)
              : formatBytes(attachment.size, { precision: 1 })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {isText ? (
            <pre className="text-sm bg-muted p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-words">
              {attachment.data}
            </pre>
          ) : (
            <div className="flex items-center justify-center">
              <FullSizeImage attachment={attachment} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
