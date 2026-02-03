import type { MessageAttachment } from './claude-types';
import {
  fileToBase64,
  formatFileSize,
  generateAttachmentId,
  isSupportedImageType,
  MAX_IMAGE_SIZE,
} from './image-utils';

/**
 * Threshold for considering text as "large" (number of lines).
 * Text with 10+ lines is shown as an attachment to avoid cluttering the input field
 * and to give users a clear visual indicator of the content size.
 */
export const LARGE_TEXT_LINE_THRESHOLD = 10;

/**
 * Threshold for considering text as "large" (character count).
 * Text with 1000+ characters is shown as an attachment even if it has few lines,
 * as long single lines can also clutter the input field.
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
 * Result of extracting images from clipboard.
 * Uses partial success pattern - returns both successful attachments and errors.
 */
export interface ClipboardImagesResult {
  attachments: MessageAttachment[];
  errors: string[];
}

interface ClipboardImageProcessingResult {
  attachment?: MessageAttachment;
  error?: string;
}

function getClipboardImageItems(items: DataTransferItemList): DataTransferItem[] {
  return Array.from(items).filter(
    (item) => item.type.startsWith('image/') && isSupportedImageType(item.type)
  );
}

function buildClipboardImageName(file: File, itemType: string): string {
  if (file.name) {
    return file.name;
  }

  const extension = itemType.split('/')[1];
  return `pasted-image-${Date.now()}.${extension}`;
}

async function processClipboardImageItem(
  item: DataTransferItem
): Promise<ClipboardImageProcessingResult> {
  const file = item.getAsFile();
  if (!file) {
    return { error: `Could not extract image from clipboard (${item.type})` };
  }

  if (file.size > MAX_IMAGE_SIZE) {
    const actualSize = formatFileSize(file.size);
    const maxSize = formatFileSize(MAX_IMAGE_SIZE);
    return { error: `Image too large: ${actualSize} (max ${maxSize})` };
  }

  try {
    const base64 = await fileToBase64(file);
    return {
      attachment: {
        id: generateAttachmentId(),
        name: buildClipboardImageName(file, item.type),
        type: item.type,
        size: file.size,
        data: base64,
        contentType: 'image',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { error: `Failed to read image: ${message}` };
  }
}

/**
 * Extract images from clipboard and convert to MessageAttachments.
 * Uses partial success pattern - continues processing after individual failures,
 * returning both successful attachments and error messages.
 *
 * @returns Object with `attachments` array and `errors` array
 */
export async function getClipboardImages(event: ClipboardEvent): Promise<ClipboardImagesResult> {
  const items = event.clipboardData?.items;
  if (!items) {
    return { attachments: [], errors: [] };
  }

  const attachments: MessageAttachment[] = [];
  const errors: string[] = [];

  const imageItems = getClipboardImageItems(items);
  for (const item of imageItems) {
    const result = await processClipboardImageItem(item);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }

  return { attachments, errors };
}

/**
 * Convert raw text to a MessageAttachment.
 *
 * @throws Error if text is empty or contains only whitespace
 */
export function textToAttachment(text: string, name?: string): MessageAttachment {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot create attachment from empty text');
  }

  const lineCount = text.split('\n').length;
  const displayName = name || `Pasted text (${lineCount} ${lineCount === 1 ? 'line' : 'lines'})`;

  return {
    id: generateAttachmentId(),
    name: displayName,
    type: 'text/plain',
    size: text.length,
    data: text,
    contentType: 'text',
  };
}

/**
 * Get text content from clipboard.
 *
 * @returns The clipboard text content, or null if no text data is available
 */
export function getClipboardText(event: ClipboardEvent): string | null {
  return event.clipboardData?.getData('text/plain') || null;
}
