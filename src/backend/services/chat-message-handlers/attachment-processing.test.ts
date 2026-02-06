/**
 * Tests for Attachment Processing Utilities
 *
 * Tests the pure helper functions for validating and processing message attachments.
 */

import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/shared/claude/protocol';
import {
  buildCombinedTextContent,
  buildContentArray,
  categorizeAttachments,
  processAttachmentsAndBuildContent,
  sanitizeAttachmentName,
  validateAttachment,
} from './attachment-processing';

// ============================================================================
// Test Helpers
// ============================================================================

function createTextAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'text-1',
    name: 'Pasted text',
    type: 'text/plain',
    size: 100,
    data: 'Sample text content',
    contentType: 'text',
    ...overrides,
  };
}

function createImageAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'image-1',
    name: 'screenshot.png',
    type: 'image/png',
    size: 1024,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    contentType: 'image',
    ...overrides,
  };
}

// ============================================================================
// validateAttachment Tests
// ============================================================================

describe('validateAttachment', () => {
  it('should accept valid text attachment', () => {
    const attachment = createTextAttachment();
    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('should accept valid image attachment with base64 data', () => {
    const attachment = createImageAttachment();
    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('should throw error if attachment is missing data', () => {
    const attachment = createTextAttachment({ data: '' });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "Pasted text" is missing data'
    );
  });

  it('should throw error if image attachment has invalid base64 data', () => {
    const attachment = createImageAttachment({
      data: 'invalid base64 with spaces!',
    });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" has invalid image data'
    );
  });

  it('should throw error if image attachment has special characters', () => {
    const attachment = createImageAttachment({
      data: 'abc@#$%def',
    });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" has invalid image data'
    );
  });

  it('should accept image attachment with valid base64 characters', () => {
    const attachment = createImageAttachment({
      data: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
    });
    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('should not validate base64 for text attachments', () => {
    const attachment = createTextAttachment({
      data: 'This is text with special chars: @#$%',
    });
    expect(() => validateAttachment(attachment)).not.toThrow();
  });
});

// ============================================================================
// sanitizeAttachmentName Tests
// ============================================================================

describe('sanitizeAttachmentName', () => {
  it('should return clean name unchanged', () => {
    expect(sanitizeAttachmentName('document.pdf')).toBe('document.pdf');
  });

  it('should remove control characters', () => {
    expect(sanitizeAttachmentName('file\x00name.txt')).toBe('filename.txt');
    expect(sanitizeAttachmentName('file\x1Fname.txt')).toBe('filename.txt');
    expect(sanitizeAttachmentName('file\x7Fname.txt')).toBe('filename.txt');
  });

  it('should limit length to 255 characters', () => {
    const longName = 'a'.repeat(300);
    expect(sanitizeAttachmentName(longName)).toHaveLength(255);
  });

  it('should handle empty string', () => {
    expect(sanitizeAttachmentName('')).toBe('');
  });

  it('should preserve unicode characters', () => {
    expect(sanitizeAttachmentName('file-émojis-😀.txt')).toBe('file-émojis-😀.txt');
  });

  it('should remove multiple control characters', () => {
    expect(sanitizeAttachmentName('\x00\x01\x02filename\x03\x04\x05.txt')).toBe('filename.txt');
  });
});

// ============================================================================
// categorizeAttachments Tests
// ============================================================================

describe('categorizeAttachments', () => {
  it('should categorize text-only attachments', () => {
    const attachments = [
      createTextAttachment({ id: 'text-1' }),
      createTextAttachment({ id: 'text-2' }),
    ];
    const result = categorizeAttachments(attachments);
    expect(result.textAttachments).toHaveLength(2);
    expect(result.imageAttachments).toHaveLength(0);
  });

  it('should categorize image-only attachments', () => {
    const attachments = [
      createImageAttachment({ id: 'image-1' }),
      createImageAttachment({ id: 'image-2' }),
    ];
    const result = categorizeAttachments(attachments);
    expect(result.textAttachments).toHaveLength(0);
    expect(result.imageAttachments).toHaveLength(2);
  });

  it('should categorize mixed attachments', () => {
    const attachments = [
      createTextAttachment({ id: 'text-1' }),
      createImageAttachment({ id: 'image-1' }),
      createTextAttachment({ id: 'text-2' }),
    ];
    const result = categorizeAttachments(attachments);
    expect(result.textAttachments).toHaveLength(2);
    expect(result.imageAttachments).toHaveLength(1);
  });

  it('should handle empty attachments array', () => {
    const result = categorizeAttachments([]);
    expect(result.textAttachments).toHaveLength(0);
    expect(result.imageAttachments).toHaveLength(0);
  });

  it('should correctly resolve attachment types without explicit contentType', () => {
    const attachments = [
      createTextAttachment({ contentType: undefined, type: 'text/plain' }),
      createImageAttachment({ contentType: undefined, type: 'image/png' }),
    ];
    const result = categorizeAttachments(attachments);
    expect(result.textAttachments).toHaveLength(1);
    expect(result.imageAttachments).toHaveLength(1);
  });
});

// ============================================================================
// buildCombinedTextContent Tests
// ============================================================================

describe('buildCombinedTextContent', () => {
  it('should return user text when no text attachments', () => {
    const result = buildCombinedTextContent('Hello world', []);
    expect(result).toBe('Hello world');
  });

  it('should append single text attachment', () => {
    const attachments = [
      createTextAttachment({ name: 'snippet.txt', data: 'console.log("test")' }),
    ];
    const result = buildCombinedTextContent('Check this code:', attachments);
    expect(result).toBe('Check this code:\n\n[Pasted content: snippet.txt]\nconsole.log("test")');
  });

  it('should append multiple text attachments', () => {
    const attachments = [
      createTextAttachment({ name: 'first.txt', data: 'First content' }),
      createTextAttachment({ name: 'second.txt', data: 'Second content' }),
    ];
    const result = buildCombinedTextContent('Message', attachments);
    expect(result).toBe(
      'Message\n\n[Pasted content: first.txt]\nFirst content\n\n[Pasted content: second.txt]\nSecond content'
    );
  });

  it('should handle empty user text', () => {
    const attachments = [createTextAttachment({ name: 'data.txt', data: 'Some data' })];
    const result = buildCombinedTextContent('', attachments);
    expect(result).toBe('[Pasted content: data.txt]\nSome data');
  });

  it('should sanitize attachment names', () => {
    const attachments = [createTextAttachment({ name: 'file\x00name.txt', data: 'content' })];
    const result = buildCombinedTextContent('Message', attachments);
    expect(result).toContain('[Pasted content: filename.txt]');
  });

  it('should handle attachment with empty name', () => {
    const attachments = [createTextAttachment({ name: '', data: 'content' })];
    const result = buildCombinedTextContent('Message', attachments);
    expect(result).toContain('[Pasted content: ]');
  });
});

// ============================================================================
// buildContentArray Tests
// ============================================================================

describe('buildContentArray', () => {
  it('should build content array with text only', () => {
    const result = buildContentArray('Hello world', []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('should build content array with empty text and images', () => {
    const imageAttachments = [createImageAttachment()];
    const result = buildContentArray('', imageAttachments);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
      },
    });
  });

  it('should build content array with text and single image', () => {
    const imageAttachments = [createImageAttachment({ type: 'image/jpeg', data: 'abc123' })];
    const result = buildContentArray('Look at this:', imageAttachments);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: 'Look at this:' });
    expect(result[1]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'abc123',
      },
    });
  });

  it('should build content array with text and multiple images', () => {
    const imageAttachments = [
      createImageAttachment({ id: 'img-1', data: 'data1' }),
      createImageAttachment({ id: 'img-2', data: 'data2' }),
    ];
    const result = buildContentArray('Multiple images:', imageAttachments);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'text', text: 'Multiple images:' });
    expect(result[1]).toMatchObject({ type: 'image' });
    expect(result[2]).toMatchObject({ type: 'image' });
  });

  it('should preserve image MIME types', () => {
    const imageAttachments = [
      createImageAttachment({ type: 'image/png' }),
      createImageAttachment({ type: 'image/jpeg' }),
      createImageAttachment({ type: 'image/webp' }),
    ];
    const result = buildContentArray('', imageAttachments);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      source: { media_type: 'image/png' },
    });
    expect(result[1]).toMatchObject({
      source: { media_type: 'image/jpeg' },
    });
    expect(result[2]).toMatchObject({
      source: { media_type: 'image/webp' },
    });
  });
});

// ============================================================================
// processAttachmentsAndBuildContent Tests (Integration)
// ============================================================================

describe('processAttachmentsAndBuildContent', () => {
  it('should return text as-is when no attachments', () => {
    const result = processAttachmentsAndBuildContent('Hello world');
    expect(result).toBe('Hello world');
  });

  it('should return text as-is when attachments array is empty', () => {
    const result = processAttachmentsAndBuildContent('Hello world', []);
    expect(result).toBe('Hello world');
  });

  it('should process text-only attachments and return string', () => {
    const attachments = [createTextAttachment({ name: 'code.ts', data: 'const x = 1;' })];
    const result = processAttachmentsAndBuildContent('Check this:', attachments);
    expect(result).toBe('Check this:\n\n[Pasted content: code.ts]\nconst x = 1;');
    expect(typeof result).toBe('string');
  });

  it('should process image-only attachments and return content array', () => {
    const attachments = [createImageAttachment()];
    const result = processAttachmentsAndBuildContent('Look:', attachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'text', text: 'Look:' });
      expect(result[1]).toMatchObject({ type: 'image' });
    }
  });

  it('should process mixed attachments and return content array', () => {
    const attachments = [createTextAttachment({ data: 'Text data' }), createImageAttachment()];
    const result = processAttachmentsAndBuildContent('Message', attachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      // First item should have combined text including the text attachment
      expect(result[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Text data'),
      });
      expect(result[1]).toMatchObject({ type: 'image' });
    }
  });

  it('should throw error if attachment is invalid', () => {
    const attachments = [createTextAttachment({ data: '' })];
    expect(() => processAttachmentsAndBuildContent('Message', attachments)).toThrow(
      'Attachment "Pasted text" is missing data'
    );
  });

  it('should validate all attachments before processing', () => {
    const attachments = [
      createTextAttachment({ id: 'valid' }),
      createImageAttachment({ id: 'invalid', data: 'invalid base64!' }),
    ];
    expect(() => processAttachmentsAndBuildContent('Message', attachments)).toThrow(
      'has invalid image data'
    );
  });

  it('should handle empty message text with text attachments', () => {
    const attachments = [createTextAttachment({ name: 'file.txt', data: 'File content' })];
    const result = processAttachmentsAndBuildContent('', attachments);
    expect(result).toBe('[Pasted content: file.txt]\nFile content');
  });

  it('should handle empty message text with image attachments', () => {
    const attachments = [createImageAttachment()];
    const result = processAttachmentsAndBuildContent('', attachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ type: 'image' });
    }
  });

  it('should process multiple text and image attachments correctly', () => {
    const attachments = [
      createTextAttachment({ id: 'text-1', name: 'first.txt', data: 'First' }),
      createTextAttachment({ id: 'text-2', name: 'second.txt', data: 'Second' }),
      createImageAttachment({ id: 'image-1' }),
      createImageAttachment({ id: 'image-2' }),
    ];
    const result = processAttachmentsAndBuildContent('Message:', attachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(3); // text + 2 images
      expect(result[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('First'),
      });
      expect(result[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Second'),
      });
      expect(result[1]).toMatchObject({ type: 'image' });
      expect(result[2]).toMatchObject({ type: 'image' });
    }
  });
});
