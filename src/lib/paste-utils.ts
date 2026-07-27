import type { MessageAttachment } from './chat-protocol';
import { getClipboardImageBlob } from './clipboard-image';
import {
  fileToBase64,
  formatFileSize,
  generateAttachmentId,
  isSupportedImageType,
  MAX_IMAGE_SIZE,
} from './image-utils';

/**
 * Threshold for considering text as "large" (number of lines).
 * Text with 20+ lines is shown as an attachment to avoid cluttering the input field
 * and to give users a clear visual indicator of the content size.
 */
export const LARGE_TEXT_LINE_THRESHOLD = 20;

/**
 * Threshold for considering text as "large" (character count).
 * Text with 2000+ characters is shown as an attachment even if it has few lines,
 * as long single lines can also clutter the input field.
 */
export const LARGE_TEXT_CHAR_THRESHOLD = 2000;

/**
 * Check if text is considered "large" and should be shown as an attachment.
 * Text is large if it has 20+ lines OR 2000+ characters.
 */
export function isLargeText(text: string): boolean {
  const lineCount = text.split('\n').length;
  return lineCount >= LARGE_TEXT_LINE_THRESHOLD || text.length >= LARGE_TEXT_CHAR_THRESHOLD;
}

/**
 * Check if a clipboard event carries any pasted image data.
 *
 * Intentionally broader than the supported-format allow-list: it also matches
 * file items whose type is an unsupported image (e.g. a macOS screenshot's
 * `image/tiff`) or empty. Those can't be used directly, but their presence means
 * the paste handler should try the platform PNG fallback in `getClipboardImages`
 * rather than treating the paste as text.
 */
export function clipboardEventHasImageItem(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) {
    return false;
  }

  for (const item of Array.from(items)) {
    if (item.kind !== 'file') {
      continue;
    }
    if (item.type === '' || item.type.startsWith('image/')) {
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

interface ExtractedClipboardImage {
  type: string;
  file: File | null;
}

/**
 * Synchronously pull the type + File out of every supported image item.
 *
 * Clipboard `DataTransferItem`s are only live during the paste event's
 * synchronous dispatch — once it completes (and certainly after any `await`),
 * the item is neutered: `getAsFile()` returns null and `item.type` returns ''.
 * We therefore capture everything we need up front, before any async work, so a
 * later `await` can't turn a pasted image's type into an empty string.
 */
function extractClipboardImages(items: DataTransferItemList): ExtractedClipboardImage[] {
  return Array.from(items)
    .filter((item) => item.type.startsWith('image/') && isSupportedImageType(item.type))
    .map((item) => ({ type: item.type, file: item.getAsFile() }));
}

function buildClipboardImageName(file: File, itemType: string): string {
  if (file.name) {
    return file.name;
  }

  const extension = itemType.split('/')[1];
  return `pasted-image-${Date.now()}.${extension}`;
}

async function processClipboardImage(
  file: File | null,
  type: string
): Promise<ClipboardImageProcessingResult> {
  if (!file) {
    return { error: `Could not extract image from clipboard (${type})` };
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
        name: buildClipboardImageName(file, type),
        type,
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

async function processClipboardImageBlob(blob: Blob): Promise<ClipboardImageProcessingResult> {
  if (blob.size > MAX_IMAGE_SIZE) {
    const actualSize = formatFileSize(blob.size);
    const maxSize = formatFileSize(MAX_IMAGE_SIZE);
    return { error: `Image too large: ${actualSize} (max ${maxSize})` };
  }

  const type = blob.type || 'image/png';
  const extension = type.split('/')[1] ?? 'png';
  const file = new File([blob], `pasted-image-${Date.now()}.${extension}`, { type });

  try {
    const base64 = await fileToBase64(file);
    return {
      attachment: {
        id: generateAttachmentId(),
        name: file.name,
        type,
        size: blob.size,
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
 * Directly-usable items (supported image types) are extracted from the paste
 * event first. If none produced an attachment but the paste still carried image
 * data (e.g. a macOS screenshot's TIFF representation), the platform PNG channel
 * is queried as a fallback.
 *
 * @returns Object with `attachments` array and `errors` array
 */
export async function getClipboardImages(event: ClipboardEvent): Promise<ClipboardImagesResult> {
  const items = event.clipboardData?.items;

  const attachments: MessageAttachment[] = [];
  const errors: string[] = [];

  // Extract synchronously first — see extractClipboardImages — then convert.
  const imageItems = items ? extractClipboardImages(items) : [];
  for (const { file, type } of imageItems) {
    const result = await processClipboardImage(file, type);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
    if (result.error) {
      errors.push(result.error);
    }
  }

  if (attachments.length === 0) {
    const blob = await getClipboardImageBlob();
    if (blob) {
      const result = await processClipboardImageBlob(blob);
      if (result.attachment) {
        attachments.push(result.attachment);
      }
      if (result.error) {
        errors.push(result.error);
      }
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
