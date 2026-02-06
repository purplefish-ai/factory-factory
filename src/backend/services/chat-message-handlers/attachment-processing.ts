/**
 * Attachment Processing Utilities
 *
 * Pure helper functions for validating and processing message attachments.
 * Extracted from chat-message-handlers.service.ts to reduce cognitive complexity.
 */

import type { ClaudeContentItem } from '@/backend/claude/types';
import type { MessageAttachment } from '@/shared/claude/protocol';
import { createLogger } from '../logger.service';
import { resolveAttachmentContentType } from './attachment-utils';

const logger = createLogger('attachment-processing');

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that an attachment has required data.
 * @throws Error if attachment is missing data
 */
function validateAttachmentHasData(attachment: MessageAttachment): void {
  if (!attachment.data) {
    logger.error('[Chat WS] Attachment missing data', { attachmentId: attachment.id });
    throw new Error(`Attachment "${attachment.name}" is missing data`);
  }
}

/**
 * Validate base64 encoding for image attachments.
 * @throws Error if attachment has invalid base64 data
 */
function validateImageBase64(attachment: MessageAttachment): void {
  // Basic base64 check - alphanumeric, +, /, =
  if (!/^[A-Za-z0-9+/=]+$/.test(attachment.data)) {
    logger.error('[Chat WS] Invalid base64 data in attachment', {
      attachmentId: attachment.id,
    });
    throw new Error(`Attachment "${attachment.name}" has invalid image data`);
  }
}

/**
 * Validate an attachment before processing.
 * Checks for required data and validates base64 encoding for images.
 * @throws Error if attachment is invalid
 */
export function validateAttachment(attachment: MessageAttachment): void {
  validateAttachmentHasData(attachment);

  const resolvedType = resolveAttachmentContentType(attachment);
  if (resolvedType === 'image') {
    validateImageBase64(attachment);
  }
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to remove them
  return name.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 255);
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
): string | ClaudeContentItem[] {
  // No attachments - return text as-is
  if (!attachments || attachments.length === 0) {
    return userText;
  }

  // Validate all attachments before processing
  for (const attachment of attachments) {
    validateAttachment(attachment);
  }

  // Categorize attachments by type
  const { textAttachments, imageAttachments } = categorizeAttachments(attachments);

  // Build combined text content (user message + text attachments)
  const combinedText = buildCombinedTextContent(userText, textAttachments);

  // If we only have text (no images), return as string
  if (imageAttachments.length === 0) {
    return combinedText;
  }

  // Build content array with text and images
  return buildContentArray(combinedText, imageAttachments);
}
