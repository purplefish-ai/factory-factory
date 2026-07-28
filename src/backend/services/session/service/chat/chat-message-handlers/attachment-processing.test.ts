/**
 * Tests for Attachment Processing Utilities
 *
 * Tests the pure helper functions for validating and processing message attachments.
 */

import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/shared/acp-protocol/protocol';
import { MAX_IMAGE_SIZE } from '@/shared/attachment-limits';
import {
  buildCombinedTextContent,
  buildContentArray,
  categorizeAttachments,
  PermanentAttachmentError,
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

function createOversizedPngBase64(): string {
  const bytes = Buffer.alloc(MAX_IMAGE_SIZE + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes.toString('base64');
}

const VALID_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';

const SUPPORTED_IMAGE_FIXTURES = [
  {
    name: 'PNG with an empty declared type',
    declaredType: '',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    expectedType: 'image/png',
  },
  {
    name: 'JPEG declared as PNG',
    declaredType: 'image/png',
    data: VALID_JPEG_BASE64,
    expectedType: 'image/jpeg',
  },
  {
    name: 'JPEG with a non-canonical declared type',
    declaredType: 'image/jpg',
    data: VALID_JPEG_BASE64,
    expectedType: 'image/jpeg',
  },
  {
    name: 'GIF declared as PNG',
    declaredType: 'image/png',
    data: 'R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==',
    expectedType: 'image/gif',
  },
  {
    name: 'WebP declared as PNG',
    declaredType: 'image/png',
    data: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
    expectedType: 'image/webp',
  },
] as const;

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
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should throw error if image attachment has invalid base64 data', () => {
    const attachment = createImageAttachment({
      data: 'invalid base64 with spaces!',
    });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" has invalid image data'
    );
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should throw error if image attachment has special characters', () => {
    const attachment = createImageAttachment({
      data: 'abc@#$%def',
    });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" has invalid image data'
    );
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should reject valid base64 that is not a supported image', () => {
    const attachment = createImageAttachment({
      data: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',
    });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" does not contain supported image data'
    );
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should accept image attachment with line-wrapped base64 data', () => {
    const attachment = createImageAttachment({
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ\r\nAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n',
    });
    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('should reject image data larger than 10 MiB before format inspection', () => {
    const attachment = createImageAttachment({
      data: 'A'.repeat(Math.ceil((MAX_IMAGE_SIZE + 1) / 3) * 4),
    });

    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" exceeds the 10 MiB image limit'
    );
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should reject oversized PNG bytes despite text metadata and forged size', () => {
    const attachment = createImageAttachment({
      type: 'text/plain',
      contentType: 'text',
      size: 1,
      data: createOversizedPngBase64(),
    });

    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" exceeds the 10 MiB image limit'
    );
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it.each([
    { format: 'PNG', data: 'iVBORw0KGgo=' },
    { format: 'JPEG', data: '/9j/' },
    { format: 'GIF', data: 'R0lGODlh' },
    { format: 'WebP', data: 'UklGRgAAAABXRUJQ' },
  ])('should reject a truncated $format with a recognized signature', ({ data }) => {
    const attachment = createImageAttachment({ data });

    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it.each([
    {
      label: 'text MIME type',
      overrides: { type: 'text/plain', contentType: undefined },
    },
    {
      label: 'text content discriminator',
      overrides: { type: 'image/png', contentType: 'text' as const },
    },
    {
      label: 'pasted-text name',
      overrides: { name: 'Pasted text', type: '', contentType: undefined },
    },
  ])('should accept image-like text with a $label', ({ overrides }) => {
    const attachment = createTextAttachment({
      ...overrides,
      data: 'iVBORw0KGgo=',
    });

    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('should reject a PNG whose image data fails its checksum', () => {
    const attachment = createImageAttachment({
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+c9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    });

    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it.each([
    {
      name: 'unknown color type',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAEAAACCwvwwAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    },
    {
      name: 'bit depth unsupported for truecolor',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABBAIAAABVh77fAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    },
  ])('should reject a PNG IHDR with $name', ({ data }) => {
    const attachment = createImageAttachment({ data });

    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should reject an animated WebP frame with no image payload chunk', () => {
    const attachment = createImageAttachment({
      data: 'UklGRhwAAABXRUJQQU5NRhAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });

    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it.each([
    {
      layout: 'ANMF without VP8X and ANIM',
      data: 'UklGRioAAABXRUJQQU5NRh4AAAAAAAAAAAAAAAAAAAAAAAAAVlA4TAUAAAAvAAAAAAA=',
    },
    {
      layout: 'ANMF without ANIM',
      data: 'UklGRjwAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5NRh4AAAAAAAAAAAAAAAAAAAAAAAAAVlA4TAUAAAAvAAAAAAA=',
    },
    {
      layout: 'ANMF before ANIM',
      data: 'UklGRkoAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5NRh4AAAAAAAAAAAAAAAAAAAAAAAAAVlA4TAUAAAAvAAAAAABBTklNBgAAAAAAAAAAAA==',
    },
    {
      layout: 'ANMF while the VP8X animation flag is clear',
      data: 'UklGRkoAAABXRUJQVlA4WAoAAAAAAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GHgAAAAAAAAAAAAAAAAAAAAAAAABWUDhMBQAAAC8AAAAAAA==',
    },
  ])('should reject an animated WebP containing $layout', ({ data }) => {
    const attachment = createImageAttachment({ data });

    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
  });

  it('should accept an animated WebP with VP8X, ANIM, and ANMF in order', () => {
    const attachment = createImageAttachment({
      data: 'UklGRkoAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GHgAAAAAAAAAAAAAAAAAAAAAAAABWUDhMBQAAAC8AAAAAAA==',
    });

    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('should throw a permanent error for unsupported image bytes', () => {
    const attachment = createImageAttachment({ type: 'image/bmp', data: 'Qk0AAAAA' });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "screenshot.png" does not contain supported image data'
    );
    expect(() => validateAttachment(attachment)).toThrow(PermanentAttachmentError);
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

  it('should strip base64 line endings from image content data', () => {
    const imageAttachments = [
      createImageAttachment({
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ\r\nAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n',
      }),
    ];
    const result = buildContentArray('', imageAttachments);

    expect(result[0]).toMatchObject({
      source: {
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });
  });
});

// ============================================================================
// processAttachmentsAndBuildContent Tests (Integration)
// ============================================================================

describe('processAttachmentsAndBuildContent', () => {
  it.each([
    {
      name: 'text MIME type',
      overrides: { type: 'text/plain', contentType: undefined },
    },
    {
      name: 'text content discriminator',
      overrides: { type: 'image/png', contentType: 'text' as const },
    },
  ])('should detect image bytes despite a $name', ({ overrides }) => {
    const attachment = createImageAttachment(overrides);

    const result = processAttachmentsAndBuildContent('Message', [attachment]);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: attachment.data,
      },
    });
    expect(attachment).toMatchObject(overrides);
  });

  it.each(SUPPORTED_IMAGE_FIXTURES)('should normalize $name from its bytes', ({
    declaredType,
    data,
    expectedType,
  }) => {
    const attachment = createImageAttachment({ type: declaredType, data });

    const result = processAttachmentsAndBuildContent('Message', [attachment]);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      type: 'image',
      source: {
        type: 'base64',
        media_type: expectedType,
        data,
      },
    });
    expect(attachment.type).toBe(declaredType);
  });

  it('should dispatch structurally invalid image-like text as text', () => {
    const attachment = createTextAttachment({ data: 'iVBORw0KGgo=' });

    expect(processAttachmentsAndBuildContent('Message', [attachment])).toBe(
      'Message\n\n[Pasted content: Pasted text]\niVBORw0KGgo='
    );
  });

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

  it('should not dispatch oversized PNG bytes mislabeled as text', () => {
    const attachment = createImageAttachment({
      type: 'text/plain',
      contentType: 'text',
      size: 1,
      data: createOversizedPngBase64(),
    });

    expect(() => processAttachmentsAndBuildContent('Message', [attachment])).toThrow(
      'Attachment "screenshot.png" exceeds the 10 MiB image limit'
    );
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
