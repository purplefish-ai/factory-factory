import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@/shared/claude';
import { resolveAttachmentContentType } from './attachment-utils';

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
