/**
 * Attachment Processing Utilities
 *
 * Pure helper functions for validating and processing message attachments.
 * Extracted from chat-message-handlers.service.ts to reduce cognitive complexity.
 */

import { createLogger } from '@/backend/services/logger.service';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { MessageAttachment } from '@/shared/acp-protocol/protocol';
import { resolveAttachmentContentType, stripBase64LineEndings } from './attachment-utils';

const logger = createLogger('attachment-processing');

type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * Thrown when an attachment is structurally invalid and cannot be dispatched.
 * This is a permanent error — retrying will always fail.
 */
export class PermanentAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentAttachmentError';
  }
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that an attachment has required data.
 * @throws PermanentAttachmentError if attachment is missing data
 */
function validateAttachmentHasData(attachment: MessageAttachment): void {
  if (!attachment.data) {
    logger.error('[Chat WS] Attachment missing data', { attachmentId: attachment.id });
    throw new PermanentAttachmentError(`Attachment "${attachment.name}" is missing data`);
  }
}

/**
 * Validate base64 encoding for image attachments.
 * @throws PermanentAttachmentError if attachment has invalid base64 data
 */
function validateImageBase64(attachment: MessageAttachment): void {
  const normalizedData = stripBase64LineEndings(attachment.data);

  // Basic base64 check - alphanumeric, +, /, =
  if (!(normalizedData && /^[A-Za-z0-9+/=]+$/.test(normalizedData))) {
    logger.error('[Chat WS] Invalid base64 data in attachment', {
      attachmentId: attachment.id,
    });
    throw new PermanentAttachmentError(`Attachment "${attachment.name}" has invalid image data`);
  }
}

function detectSupportedImageMediaType(data: string): SupportedImageMediaType | null {
  const bytes = Buffer.from(data, 'base64');

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'image/gif';
    }
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function normalizeAttachment(attachment: MessageAttachment): MessageAttachment {
  validateAttachmentHasData(attachment);

  if (resolveAttachmentContentType(attachment) !== 'image') {
    return attachment;
  }

  validateImageBase64(attachment);
  const detectedType = detectSupportedImageMediaType(stripBase64LineEndings(attachment.data));
  if (!detectedType) {
    logger.error('[Chat WS] Unsupported image data', {
      attachmentId: attachment.id,
      declaredType: attachment.type,
    });
    throw new PermanentAttachmentError(
      `Attachment "${attachment.name}" does not contain supported image data`
    );
  }

  return attachment.type === detectedType ? attachment : { ...attachment, type: detectedType };
}

/**
 * Validate an attachment before processing.
 * Checks for required data and validates base64 encoding for images.
 * @throws PermanentAttachmentError if attachment is structurally invalid
 */
export function validateAttachment(attachment: MessageAttachment): void {
  normalizeAttachment(attachment);
}

// ============================================================================
// Sanitization Helpers
// ============================================================================

/**
 * Sanitize attachment name to prevent log injection or display issues.
 * Removes control characters and limits length.
 */
export function sanitizeAttachmentName(name: string): string {
  // Remove control characters (ASCII 0-31 and 127) and limit length
  const sanitized = Array.from(name)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  return sanitized.slice(0, 255);
}

// ============================================================================
// Attachment Categorization
// ============================================================================

interface CategorizedAttachments {
  textAttachments: MessageAttachment[];
  imageAttachments: MessageAttachment[];
}

/**
 * Categorize attachments into text and image types.
 */
export function categorizeAttachments(attachments: MessageAttachment[]): CategorizedAttachments {
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

// ============================================================================
// Content Building Helpers
// ============================================================================

/**
 * Build combined text content from user message and text attachments.
 * Appends text attachments with a prefix for context.
 */
export function buildCombinedTextContent(
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
 * Build Claude content array with text and image attachments.
 * Returns an array of content items suitable for Claude's API.
 */
export function buildContentArray(
  combinedText: string,
  imageAttachments: MessageAttachment[]
): AgentContentItem[] {
  const content: AgentContentItem[] = [];

  if (combinedText) {
    content.push({ type: 'text', text: combinedText });
  }

  for (const attachment of imageAttachments) {
    const imageContent: Extract<AgentContentItem, { type: 'image' }> = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.type as SupportedImageMediaType,
        data: stripBase64LineEndings(attachment.data),
      },
    };
    content.push(imageContent);
  }

  return content;
}

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Process attachments and build message content for Claude.
 * Validates all attachments, categorizes them, and builds appropriate content.
 *
 * @param userText - The user's message text
 * @param attachments - Array of message attachments (optional)
 * @returns Either a string (text-only) or content array (with images)
 */
export function processAttachmentsAndBuildContent(
  userText: string,
  attachments?: MessageAttachment[]
): string | AgentContentItem[] {
  // No attachments - return text as-is
  if (!attachments || attachments.length === 0) {
    return userText;
  }

  const normalizedAttachments = attachments.map(normalizeAttachment);

  // Categorize attachments by type
  const { textAttachments, imageAttachments } = categorizeAttachments(normalizedAttachments);

  // Build combined text content (user message + text attachments)
  const combinedText = buildCombinedTextContent(userText, textAttachments);

  // If we only have text (no images), return as string
  if (imageAttachments.length === 0) {
    return combinedText;
  }

  // Build content array with text and images
  return buildContentArray(combinedText, imageAttachments);
}
