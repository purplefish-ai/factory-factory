import type { MessageAttachment } from './claude-types';
import {
  fileToBase64,
  generateAttachmentId,
  isSupportedImageType,
  MAX_IMAGE_SIZE,
} from './image-utils';

/**
 * Threshold for considering text as "large" (number of lines).
 */
export const LARGE_TEXT_LINE_THRESHOLD = 10;

/**
 * Threshold for considering text as "large" (character count).
 */
export const LARGE_TEXT_CHAR_THRESHOLD = 1000;

/**
 * Check if text is considered "large" and should be shown as an attachment.
 * Text is large if it has 10+ lines OR 1000+ characters.
 */
export function isLargeText(text: string): boolean {
  const lineCount = text.split('\n').length;
  return lineCount >= LARGE_TEXT_LINE_THRESHOLD || text.length >= LARGE_TEXT_CHAR_THRESHOLD;
}

/**
 * Check if clipboard event contains images.
 */
export function hasClipboardImages(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) {
    return false;
  }

  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/') && isSupportedImageType(item.type)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract images from clipboard and convert to MessageAttachments.
 */
export async function getClipboardImages(event: ClipboardEvent): Promise<MessageAttachment[]> {
  const items = event.clipboardData?.items;
  if (!items) {
    return [];
  }

  const attachments: MessageAttachment[] = [];

  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/') && isSupportedImageType(item.type)) {
      const file = item.getAsFile();
      if (file) {
        // Check file size
        if (file.size > MAX_IMAGE_SIZE) {
          throw new Error(`Image too large: ${(file.size / 1024 / 1024).toFixed(2)}MB (max 10MB)`);
        }

        const base64 = await fileToBase64(file);
        attachments.push({
          id: generateAttachmentId(),
          name: file.name || `pasted-image-${Date.now()}.${item.type.split('/')[1]}`,
          type: item.type,
          size: file.size,
          data: base64,
          contentType: 'image',
        });
      }
    }
  }

  return attachments;
}

/**
 * Convert raw text to a MessageAttachment.
 */
export function textToAttachment(text: string, name?: string): MessageAttachment {
  const lineCount = text.split('\n').length;
  const displayName = name || `Pasted text (${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`;

  return {
    id: generateAttachmentId(),
    name: displayName,
    type: 'text/plain',
    size: text.length,
    data: text, // raw text, not base64
    contentType: 'text',
  };
}

/**
 * Get text content from clipboard.
 */
export function getClipboardText(event: ClipboardEvent): string | null {
  return event.clipboardData?.getData('text/plain') || null;
}
