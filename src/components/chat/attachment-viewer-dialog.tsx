import { FileText } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { formatFileSize, formatLineCount, isTextAttachment } from '@/lib/image-utils';

interface AttachmentViewerDialogProps {
  attachment: MessageAttachment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
            {isText && <FileText className="h-5 w-5 text-muted-foreground" />}
            {attachment.name}
          </DialogTitle>
          <DialogDescription>
            {isText ? formatLineCount(attachment.data) : formatFileSize(attachment.size)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {isText ? (
            <pre className="text-sm bg-muted p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-words">
              {attachment.data}
            </pre>
          ) : (
            <div className="flex items-center justify-center">
              <img
                src={`data:${attachment.type};base64,${attachment.data}`}
                alt={attachment.name}
                className="max-w-full max-h-[70vh] object-contain rounded-lg"
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
