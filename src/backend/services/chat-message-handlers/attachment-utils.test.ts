import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/shared/claude';
import {
  buildContentWithAttachments,
  combineTextWithAttachments,
  partitionAttachments,
  resolveAttachmentContentType,
  sanitizeAttachmentName,
  validateAttachment,
} from './attachment-utils';

function createAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att-1',
    name: 'attachment',
    type: 'text/plain',
    size: 10,
    data: 'hello world',
    ...overrides,
  };
}

describe('resolveAttachmentContentType', () => {
  it('prefers explicit contentType', () => {
    expect(resolveAttachmentContentType(createAttachment({ contentType: 'text' }))).toBe('text');
    expect(resolveAttachmentContentType(createAttachment({ contentType: 'image' }))).toBe('image');
  });

  it('uses MIME type when present', () => {
    expect(
      resolveAttachmentContentType(createAttachment({ type: 'text/plain', data: 'SGVsbG8=' }))
    ).toBe('text');
    expect(
      resolveAttachmentContentType(createAttachment({ type: 'image/png', data: 'iVBORw0KGgo=' }))
    ).toBe('image');
  });

  it('treats pasted text names as text', () => {
    expect(
      resolveAttachmentContentType(
        createAttachment({
          type: '',
          name: 'Pasted text (3 lines)',
          data: 'SGVsbG8=',
        })
      )
    ).toBe('text');
  });

  it('treats non-base64 payloads as text', () => {
    expect(
      resolveAttachmentContentType(
        createAttachment({ type: '', name: 'notes', data: 'hello\nworld' })
      )
    ).toBe('text');
  });

  it('defaults to image for base64-like data when type is unknown', () => {
    expect(
      resolveAttachmentContentType(createAttachment({ type: '', name: 'blob', data: 'SGVsbG8=' }))
    ).toBe('image');
  });
});

describe('validateAttachment', () => {
  it('throws error when attachment data is missing', () => {
    const attachment = createAttachment({ data: '' });
    expect(() => validateAttachment(attachment)).toThrow('Attachment "attachment" is missing data');
  });

  it('throws error when image attachment has invalid base64 data', () => {
    const attachment = createAttachment({
      name: 'image.png',
      type: 'image/png',
      data: 'invalid base64 with spaces!',
    });
    expect(() => validateAttachment(attachment)).toThrow(
      'Attachment "image.png" has invalid image data'
    );
  });

  it('passes validation for valid text attachment', () => {
    const attachment = createAttachment({
      type: 'text/plain',
      data: 'hello world',
    });
    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('passes validation for valid image attachment with base64 data', () => {
    const attachment = createAttachment({
      name: 'image.png',
      type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    });
    expect(() => validateAttachment(attachment)).not.toThrow();
  });

  it('allows text attachment with non-base64 data', () => {
    const attachment = createAttachment({
      type: 'text/plain',
      data: 'hello\nworld with special chars!',
    });
    expect(() => validateAttachment(attachment)).not.toThrow();
  });
});

describe('sanitizeAttachmentName', () => {
  it('removes control characters', () => {
    expect(sanitizeAttachmentName('file\x00name')).toBe('filename');
    expect(sanitizeAttachmentName('file\x1Fname')).toBe('filename');
    expect(sanitizeAttachmentName('file\x7Fname')).toBe('filename');
  });

  it('limits length to 255 characters', () => {
    const longName = 'a'.repeat(300);
    expect(sanitizeAttachmentName(longName)).toHaveLength(255);
  });

  it('preserves normal filenames', () => {
    expect(sanitizeAttachmentName('document.txt')).toBe('document.txt');
    expect(sanitizeAttachmentName('My File (2).pdf')).toBe('My File (2).pdf');
  });
});

describe('partitionAttachments', () => {
  it('separates text and image attachments', () => {
    const attachments = [
      createAttachment({ id: 'txt-1', type: 'text/plain', data: 'hello' }),
      createAttachment({ id: 'img-1', type: 'image/png', data: 'iVBORw0KGgo=' }),
      createAttachment({ id: 'txt-2', type: 'text/markdown', data: '# Title' }),
    ];

    const result = partitionAttachments(attachments);
    expect(result.textAttachments).toHaveLength(2);
    expect(result.imageAttachments).toHaveLength(1);
    expect(result.textAttachments[0].id).toBe('txt-1');
    expect(result.textAttachments[1].id).toBe('txt-2');
    expect(result.imageAttachments[0].id).toBe('img-1');
  });

  it('returns empty arrays when no attachments match', () => {
    const textOnly = [createAttachment({ type: 'text/plain', data: 'hello' })];
    const result1 = partitionAttachments(textOnly);
    expect(result1.textAttachments).toHaveLength(1);
    expect(result1.imageAttachments).toHaveLength(0);

    const imageOnly = [createAttachment({ type: 'image/png', data: 'iVBORw0KGgo=' })];
    const result2 = partitionAttachments(imageOnly);
    expect(result2.textAttachments).toHaveLength(0);
    expect(result2.imageAttachments).toHaveLength(1);
  });

  it('handles empty array', () => {
    const result = partitionAttachments([]);
    expect(result.textAttachments).toHaveLength(0);
    expect(result.imageAttachments).toHaveLength(0);
  });
});

describe('combineTextWithAttachments', () => {
  it('combines user text with text attachments', () => {
    const userText = 'Please review:';
    const attachments = [
      createAttachment({ name: 'doc.txt', data: 'Document content' }),
      createAttachment({ name: 'notes.md', data: 'Some notes' }),
    ];

    const result = combineTextWithAttachments(userText, attachments);
    expect(result).toContain('Please review:');
    expect(result).toContain('[Pasted content: doc.txt]');
    expect(result).toContain('Document content');
    expect(result).toContain('[Pasted content: notes.md]');
    expect(result).toContain('Some notes');
  });

  it('handles empty user text', () => {
    const attachments = [createAttachment({ name: 'doc.txt', data: 'Content' })];
    const result = combineTextWithAttachments('', attachments);
    expect(result).toBe('[Pasted content: doc.txt]\nContent');
  });

  it('handles no attachments', () => {
    const result = combineTextWithAttachments('Hello world', []);
    expect(result).toBe('Hello world');
  });

  it('sanitizes attachment names', () => {
    const attachments = [createAttachment({ name: 'file\x00name.txt', data: 'Content' })];
    const result = combineTextWithAttachments('Text', attachments);
    expect(result).toContain('[Pasted content: filename.txt]');
  });
});

describe('buildContentWithAttachments', () => {
  it('returns string when no images', () => {
    const result = buildContentWithAttachments('Hello world', []);
    expect(result).toBe('Hello world');
  });

  it('returns content array with text and images', () => {
    const imageAttachments = [
      createAttachment({
        id: 'img-1',
        name: 'image.png',
        type: 'image/png',
        data: 'base64data',
      }),
    ];

    const result = buildContentWithAttachments('Check this out:', imageAttachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: 'text', text: 'Check this out:' });
      expect(result[1]).toMatchObject({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'base64data',
        },
      });
    }
  });

  it('returns content array with only images when text is empty', () => {
    const imageAttachments = [
      createAttachment({
        name: 'image.png',
        type: 'image/png',
        data: 'base64data',
      }),
    ];

    const result = buildContentWithAttachments('', imageAttachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'base64data',
        },
      });
    }
  });

  it('handles multiple images', () => {
    const imageAttachments = [
      createAttachment({ id: 'img-1', type: 'image/png', data: 'data1' }),
      createAttachment({ id: 'img-2', type: 'image/jpeg', data: 'data2' }),
    ];

    const result = buildContentWithAttachments('Images:', imageAttachments);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(3); // 1 text + 2 images
    }
  });
});
