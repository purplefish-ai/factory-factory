import type { ClaudeContentItem, MessageAttachment } from '@/shared/claude';

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
 * Sanitize attachment name to prevent log injection or display issues.
 * Removes control characters and limits length.
 */
export function sanitizeAttachmentName(name: string): string {
  // Remove control characters (ASCII 0-31 and 127) and limit length
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to remove them
  return name.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 255);
}

export interface PartitionedAttachments {
  textAttachments: MessageAttachment[];
  imageAttachments: MessageAttachment[];
}

/**
 * Partition attachments into text and image categories based on their resolved content type.
 */
export function partitionAttachments(attachments: MessageAttachment[]): PartitionedAttachments {
  const resolvedAttachments = attachments.map((attachment) => ({
    attachment,
    contentType: resolveAttachmentContentType(attachment),
  }));

  const textAttachments = resolvedAttachments
    .filter((entry) => entry.contentType === 'text')
    .map((entry) => entry.attachment);

  const imageAttachments = resolvedAttachments
    .filter((entry) => entry.contentType === 'image')
    .map((entry) => entry.attachment);

  return { textAttachments, imageAttachments };
}

/**
 * Combine user message text with text attachments.
 * Each text attachment is prefixed with "[Pasted content: filename]".
 */
export function combineTextWithAttachments(
  userText: string,
  textAttachments: MessageAttachment[]
): string {
  let combinedText = userText || '';

  for (const attachment of textAttachments) {
    const prefix = combinedText ? '\n\n' : '';
    const safeName = sanitizeAttachmentName(attachment.name);
    combinedText += `${prefix}[Pasted content: ${safeName}]\n${attachment.data}`;
  }

  return combinedText;
}

/**
 * Build Claude message content from text and image attachments.
 * Returns a string if there are no images, or an array of content items if images are present.
 */
export function buildContentWithAttachments(
  combinedText: string,
  imageAttachments: MessageAttachment[]
): string | ClaudeContentItem[] {
  // If no images, return the combined text as-is
  if (imageAttachments.length === 0) {
    return combinedText;
  }

  // Build content array with text (if present) and images
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
