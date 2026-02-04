import type { MessageAttachment } from '@/shared/claude';
import type { ClaudeContentItem } from '../../claude/types';

const PASTED_TEXT_NAME = /^Pasted text\b/i;
const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

function looksLikeBase64(data: string): boolean {
  return BASE64_REGEX.test(data);
}

function isNameLikelyText(name: string): boolean {
  return PASTED_TEXT_NAME.test(name);
}

type AttachmentLike = Pick<MessageAttachment, 'name' | 'type' | 'data' | 'contentType'>;

export function resolveAttachmentContentType(attachment: AttachmentLike): 'text' | 'image' {
  if (attachment.contentType === 'text' || attachment.contentType === 'image') {
    return attachment.contentType;
  }

  if (attachment.type?.startsWith('text/')) {
    return 'text';
  }

  if (attachment.type?.startsWith('image/')) {
    return 'image';
  }

  if (isNameLikelyText(attachment.name)) {
    return 'text';
  }

  if (!looksLikeBase64(attachment.data)) {
    return 'text';
  }

  return 'image';
}

/**
 * Sanitize attachment name to prevent log injection or display issues.
 * Removes control characters and limits length.
 */
export function sanitizeAttachmentName(name: string): string {
  // Remove control characters (ASCII 0-31 and 127) and limit length
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to remove them
  return name.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 255);
}

/**
 * Validate an attachment before processing.
 * @throws Error if attachment is invalid
 */
export function validateAttachment(attachment: {
  id: string;
  name: string;
  type: string;
  data: string;
  contentType?: 'image' | 'text';
}): void {
  if (!attachment.data) {
    throw new Error(`Attachment "${attachment.name}" is missing data`);
  }

  const resolvedType = resolveAttachmentContentType(attachment);
  if (resolvedType === 'image') {
    // Validate base64 for image attachments (basic check - alphanumeric, +, /, =)
    if (!BASE64_REGEX.test(attachment.data)) {
      throw new Error(`Attachment "${attachment.name}" has invalid image data`);
    }
  }
}

/**
 * Partition attachments into text and image groups.
 */
export function partitionAttachments(attachments: MessageAttachment[]): {
  textAttachments: MessageAttachment[];
  imageAttachments: MessageAttachment[];
} {
  const textAttachments: MessageAttachment[] = [];
  const imageAttachments: MessageAttachment[] = [];

  for (const attachment of attachments) {
    const contentType = resolveAttachmentContentType(attachment);
    if (contentType === 'text') {
      textAttachments.push(attachment);
    } else {
      imageAttachments.push(attachment);
    }
  }

  return { textAttachments, imageAttachments };
}

/**
 * Build combined text from message text and text attachments.
 */
export function buildCombinedText(
  messageText: string,
  textAttachments: MessageAttachment[]
): string {
  let combinedText = messageText || '';

  for (const attachment of textAttachments) {
    const prefix = combinedText ? '\n\n' : '';
    const safeName = sanitizeAttachmentName(attachment.name);
    combinedText += `${prefix}[Pasted content: ${safeName}]\n${attachment.data}`;
  }

  return combinedText;
}

/**
 * Build a content array from text and image attachments.
 */
export function buildContentArray(
  combinedText: string,
  imageAttachments: MessageAttachment[]
): ClaudeContentItem[] {
  const content: ClaudeContentItem[] = [];

  if (combinedText) {
    content.push({ type: 'text', text: combinedText });
  }

  for (const attachment of imageAttachments) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.type,
        data: attachment.data,
      },
    } as unknown as ClaudeContentItem);
  }

  return content;
}
