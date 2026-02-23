import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import type { MessageAttachment } from '@/lib/chat-protocol';
import { SUPPORTED_TEXT_EXTENSIONS } from '@/lib/image-utils';
import {
  getClipboardImages,
  getClipboardText,
  hasClipboardImages,
  isLargeText,
  textToAttachment,
} from '@/lib/paste-utils';
import { collectAttachments } from './attachment-file-conversion';

interface UsePasteDropHandlerOptions {
  setAttachments: (
    updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])
  ) => void;
  disabled?: boolean;
}

interface UsePasteDropHandlerReturn {
  handlePaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (event: ReactDragEvent<HTMLTextAreaElement>) => void;
  handleDragOver: (event: ReactDragEvent<HTMLTextAreaElement>) => void;
  handleDragLeave: (event: ReactDragEvent<HTMLTextAreaElement>) => void;
  isDragging: boolean;
}

function shouldConvertTextToAttachment(text: string | null): text is string {
  return !!text && text.trim().length > 0 && isLargeText(text);
}

async function handleClipboardImagePaste(
  event: ReactClipboardEvent<HTMLTextAreaElement>,
  setAttachments: (
    updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])
  ) => void
): Promise<void> {
  try {
    const { attachments: imageAttachments, errors } = await getClipboardImages(event.nativeEvent);
    if (imageAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...imageAttachments]);
    }
    if (errors.length > 0) {
      toast.error(errors.join('; '));
      return;
    }
    if (imageAttachments.length === 0) {
      toast.error('Could not paste image from clipboard');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to paste image';
    toast.error(message);
  }
}

async function handleFileDrop(
  files: FileList,
  setAttachments: (
    updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])
  ) => void
): Promise<void> {
  const { attachments: newAttachments, errors } = await collectAttachments(files);

  if (newAttachments.length > 0) {
    setAttachments((prev) => [...prev, ...newAttachments]);
  }

  if (errors.length > 0) {
    const supportedExts = SUPPORTED_TEXT_EXTENSIONS.join(', ');
    const formattedErrors = errors.map(({ fileName, message }) => `${fileName}: ${message}`);
    toast.error(
      `Could not add ${errors.length} file(s): ${formattedErrors.join(
        '; '
      )}\n\nSupported text files: ${supportedExts}`
    );
  }
}

/**
 * Hook to handle paste and drag-drop events for the chat input.
 *
 * Paste behavior:
 * - Images: Always convert to attachments
 * - Large text (10+ lines or 1000+ chars): Convert to text attachment
 * - Small text: Default behavior (insert inline)
 *
 * Drop behavior:
 * - Image files: Convert to attachments
 * - Text files (.txt, .md, etc.): Convert to text attachments
 * - Other files: Show error toast
 */
export function usePasteDropHandler({
  setAttachments,
  disabled = false,
}: UsePasteDropHandlerOptions): UsePasteDropHandlerReturn {
  const [isDragging, setIsDragging] = useState(false);

  /**
   * Handle paste events.
   * - Check for images first (they take priority)
   * - Check for large text (convert to attachment)
   * - Small text falls through to default behavior
   */
  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }

      // Check for images first
      if (hasClipboardImages(event.nativeEvent)) {
        event.preventDefault();
        void handleClipboardImagePaste(event, setAttachments);
        return;
      }

      // Check for large text (must have non-whitespace content)
      const text = getClipboardText(event.nativeEvent);
      if (shouldConvertTextToAttachment(text)) {
        event.preventDefault();
        const attachment = textToAttachment(text);
        setAttachments((prev) => [...prev, attachment]);
        return;
      }

      // Small text - let default behavior handle it (inserts inline)
    },
    [disabled, setAttachments]
  );

  /**
   * Handle drop events.
   * - Accept image files and convert to attachments
   * - Accept text files and convert to text attachments
   * - Show error for unsupported file types
   */
  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      setIsDragging(false);

      if (disabled) {
        return;
      }

      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }

      void handleFileDrop(files, setAttachments);
    },
    [disabled, setAttachments]
  );

  /**
   * Handle drag over to show visual feedback.
   */
  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      if (!disabled) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  /**
   * Handle drag leave to hide visual feedback.
   */
  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  return {
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
    isDragging,
  };
}
