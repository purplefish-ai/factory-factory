import type { ClipboardEvent, DragEvent } from 'react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import type { MessageAttachment } from '@/lib/claude-types';
import {
  fileToAttachment,
  isSupportedImageType,
  isSupportedTextFile,
  SUPPORTED_TEXT_EXTENSIONS,
  textFileToAttachment,
} from '@/lib/image-utils';
import {
  getClipboardImages,
  getClipboardText,
  hasClipboardImages,
  isLargeText,
  textToAttachment,
} from '@/lib/paste-utils';

interface UsePasteDropHandlerOptions {
  setAttachments: (
    updater: MessageAttachment[] | ((prev: MessageAttachment[]) => MessageAttachment[])
  ) => void;
  disabled?: boolean;
}

interface UsePasteDropHandlerReturn {
  handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
  handleDragOver: (event: DragEvent<HTMLTextAreaElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLTextAreaElement>) => void;
  isDragging: boolean;
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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: paste handling requires multiple conditional paths
    async (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }

      // Check for images first
      if (hasClipboardImages(event.nativeEvent)) {
        event.preventDefault();
        try {
          const imageAttachments = await getClipboardImages(event.nativeEvent);
          if (imageAttachments.length > 0) {
            setAttachments((prev) => [...prev, ...imageAttachments]);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to paste image';
          toast.error(message);
        }
        return;
      }

      // Check for large text
      const text = getClipboardText(event.nativeEvent);
      if (text && isLargeText(text)) {
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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: drop handling requires multiple conditional paths
    async (event: DragEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      setIsDragging(false);

      if (disabled) {
        return;
      }

      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }

      const newAttachments: MessageAttachment[] = [];
      const errors: string[] = [];

      for (const file of Array.from(files)) {
        try {
          // Check if it's an image
          if (isSupportedImageType(file.type)) {
            const attachment = await fileToAttachment(file);
            // Add contentType for consistency
            attachment.contentType = 'image';
            newAttachments.push(attachment);
          }
          // Check if it's a supported text file
          else if (isSupportedTextFile(file.name)) {
            const attachment = await textFileToAttachment(file);
            newAttachments.push(attachment);
          }
          // Unsupported file type
          else {
            errors.push(`${file.name}: unsupported file type`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`${file.name}: ${message}`);
        }
      }

      // Add successful attachments
      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments]);
      }

      // Show errors
      if (errors.length > 0) {
        const supportedExts = SUPPORTED_TEXT_EXTENSIONS.join(', ');
        toast.error(
          `Could not add ${errors.length} file(s): ${errors.join('; ')}\n\nSupported text files: ${supportedExts}`
        );
      }
    },
    [disabled, setAttachments]
  );

  /**
   * Handle drag over to show visual feedback.
   */
  const handleDragOver = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
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
  const handleDragLeave = useCallback((event: DragEvent<HTMLTextAreaElement>) => {
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
