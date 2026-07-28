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
import {
  inspectSupportedImageFormat,
  type SupportedImageMediaType,
} from './image-format-validation';

const logger = createLogger('attachment-processing');

// Mirrors the upload limit enforced by src/lib/image-utils.ts. This boundary
// cannot trust MessageAttachment.size because it is client-provided.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_IMAGE_CHARACTERS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const IMAGE_SIGNATURE_BASE64_CHARACTERS = 16;

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
  if (!hasValidBase64Characters(normalizedData)) {
    logger.error('[Chat WS] Invalid base64 data in attachment', {
      attachmentId: attachment.id,
    });
    throw new PermanentAttachmentError(`Attachment "${attachment.name}" has invalid image data`);
  }
}

function hasValidBase64Characters(data: string): boolean {
  return Boolean(data && /^[A-Za-z0-9+/=]+$/.test(data));
}

function decodedBase64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor(((data.length - padding) * 3) / 4);
}

function exceedsImageSizeLimit(data: string): boolean {
  return (
    data.length > MAX_BASE64_IMAGE_CHARACTERS || decodedBase64ByteLength(data) > MAX_IMAGE_BYTES
  );
}

function hasSupportedImageSignature(data: string): boolean {
  const encodedSignature = data.slice(0, IMAGE_SIGNATURE_BASE64_CHARACTERS);
  return (
    hasValidBase64Characters(encodedSignature) &&
    inspectSupportedImageFormat(Buffer.from(encodedSignature, 'base64')) !== null
  );
}

function normalizeAttachment(attachment: MessageAttachment): MessageAttachment {
  validateAttachmentHasData(attachment);

  const normalizedData = stripBase64LineEndings(attachment.data);
  if (exceedsImageSizeLimit(normalizedData)) {
    if (
      !hasSupportedImageSignature(normalizedData) &&
      resolveAttachmentContentType(attachment) !== 'image'
    ) {
      return attachment;
    }
    logger.error('[Chat WS] Image attachment exceeds size limit', {
      attachmentId: attachment.id,
    });
    throw new PermanentAttachmentError(
      `Attachment "${attachment.name}" exceeds the 10 MiB image limit`
    );
  }

  const imageInspection = hasValidBase64Characters(normalizedData)
    ? inspectSupportedImageFormat(Buffer.from(normalizedData, 'base64'))
    : null;

  if (imageInspection) {
    if (!imageInspection.isValid) {
      logger.error('[Chat WS] Invalid image structure', {
        attachmentId: attachment.id,
        declaredType: attachment.type,
        detectedType: imageInspection.mediaType,
      });
      throw new PermanentAttachmentError(
        `Attachment "${attachment.name}" does not contain valid ${imageInspection.mediaType} data`
      );
    }

    if (attachment.type === imageInspection.mediaType && attachment.contentType === 'image') {
      return attachment;
    }
    return {
      ...attachment,
      type: imageInspection.mediaType,
      contentType: 'image',
    };
  }

  if (resolveAttachmentContentType(attachment) !== 'image') {
    return attachment;
  }

  validateImageBase64(attachment);
  logger.error('[Chat WS] Unsupported image data', {
    attachmentId: attachment.id,
    declaredType: attachment.type,
  });
  throw new PermanentAttachmentError(
    `Attachment "${attachment.name}" does not contain supported image data`
  );
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
