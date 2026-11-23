import { describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '@/lib/chat-protocol';
import { attachmentImageSrc, materializeAttachments, SentChatImages } from './chat-images';

const ID = 'c'.repeat(64);
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 250, 251, 252]);
const base64 = Buffer.from(bytes).toString('base64');

function referenced(id = 'att-1'): MessageAttachment {
  return {
    id,
    name: 'shot.png',
    type: 'image/png',
    size: bytes.length,
    data: '',
    contentType: 'image',
    ref: { id: ID, size: bytes.length, width: 4, height: 3 },
  };
}

function inline(id = 'att-1'): MessageAttachment {
  return { ...referenced(id), data: base64, ref: undefined };
}

function okFetch() {
  return vi.fn(async () => new Response(bytes, { status: 200 }));
}

describe('chat images', () => {
  it('shows inline bytes inline and references from the immutable image URL', () => {
    const sent = new SentChatImages();
    expect(attachmentImageSrc(inline(), sent)).toBe(`data:image/png;base64,${base64}`);
    expect(attachmentImageSrc(referenced(), sent)).toBe(`/api/chat-images/${ID}`);
    expect(
      attachmentImageSrc({ ...inline(), type: 'text/plain', contentType: 'text', data: 'hi' }, sent)
    ).toBeNull();
    expect(attachmentImageSrc({ ...referenced(), ref: undefined }, sent)).toBeNull();
  });

  it('shows an image this tab sent from its own copy, without a request', () => {
    const sent = new SentChatImages();
    sent.remember([inline('mine')]);
    expect(attachmentImageSrc(referenced('mine'), sent)).toBe(`data:image/png;base64,${base64}`);
    expect(attachmentImageSrc(referenced('theirs'), sent)).toBe(`/api/chat-images/${ID}`);
  });

  it('restores the bytes of referenced attachments before they are sent again', async () => {
    const sent = new SentChatImages();
    sent.remember([inline('mine')]);
    const fetchImage = okFetch();

    const restored = await materializeAttachments(
      [inline('kept'), referenced('mine'), referenced('fetched')],
      { sent, fetchImage }
    );

    expect(restored).toEqual([inline('kept'), inline('mine'), inline('fetched')]);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledWith(`/api/chat-images/${ID}`);
  });

  it('keeps a bounded number of sent images', () => {
    const sent = new SentChatImages({ maxImages: 2 });
    sent.remember([inline('one'), inline('two'), inline('three')]);
    expect(attachmentImageSrc(referenced('one'), sent)).toBe(`/api/chat-images/${ID}`);
    expect(attachmentImageSrc(referenced('three'), sent)).toBe(`data:image/png;base64,${base64}`);

    const small = new SentChatImages({ maxChars: base64.length * 2 });
    small.remember([inline('one'), inline('two'), inline('three')]);
    expect(attachmentImageSrc(referenced('one'), small)).toBe(`/api/chat-images/${ID}`);
    expect(attachmentImageSrc(referenced('two'), small)).toBe(`data:image/png;base64,${base64}`);
  });

  it('returns the same array when nothing needs restoring, and fails when an image is gone', async () => {
    const sent = new SentChatImages();
    const fetchImage = okFetch();
    const attachments = [inline()];
    expect(await materializeAttachments(attachments, { sent, fetchImage })).toBe(attachments);
    expect(fetchImage).not.toHaveBeenCalled();

    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      materializeAttachments([referenced()], { sent, fetchImage: missing })
    ).rejects.toThrow(/shot\.png.*no longer available/);
  });
});
