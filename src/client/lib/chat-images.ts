/**
 * Chat images the server sends as references (`@/shared/chat-image-ref`).
 *
 * A referenced image is shown from its immutable URL, which the browser's HTTP
 * cache keeps, so a later session load downloads nothing; if the cache lost
 * it, the browser simply fetches it again. Images this tab sent are shown from
 * the tab's own copy, so a sent message needs no round trip.
 */
import type { MessageAttachment } from '@/lib/chat-protocol';
import { chatImageUrl } from '@/shared/chat-image-ref';

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.contentType !== 'text';
}

/**
 * The base64 of images this tab sent, by attachment id, most recent last.
 * Bounded so a phone does not hold many large images; an evicted one is
 * fetched once from its URL instead.
 */
export class SentChatImages {
  private readonly images = new Map<string, string>();
  private readonly maxImages: number;
  private readonly maxChars: number;
  private chars = 0;

  constructor(options?: { maxImages?: number; maxChars?: number }) {
    this.maxImages = options?.maxImages ?? 16;
    this.maxChars = options?.maxChars ?? 48 * 1024 * 1024;
  }

  remember(attachments: readonly MessageAttachment[]): void {
    for (const attachment of attachments) {
      if (!(isImageAttachment(attachment) && attachment.data)) {
        continue;
      }
      this.chars -= this.images.get(attachment.id)?.length ?? 0;
      this.images.delete(attachment.id);
      this.images.set(attachment.id, attachment.data);
      this.chars += attachment.data.length;
    }
    for (const [id, data] of this.images) {
      if (this.images.size <= this.maxImages && this.chars <= this.maxChars) {
        break;
      }
      this.images.delete(id);
      this.chars -= data.length;
    }
  }

  get(id: string): string | undefined {
    return this.images.get(id);
  }
}

/** The images sent from this tab; the attachment ids survive the server's echo. */
export const sentChatImages = new SentChatImages();

/** Where to load an image attachment from, or null for text or a missing image. */
export function attachmentImageSrc(
  attachment: MessageAttachment,
  sent: SentChatImages = sentChatImages
): string | null {
  if (!isImageAttachment(attachment)) {
    return null;
  }
  const data = attachment.data || sent.get(attachment.id);
  if (data) {
    return `data:${attachment.type};base64,${data}`;
  }
  return attachment.ref ? chatImageUrl(attachment.ref.id) : null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x80_00;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * Inline the bytes of referenced attachments, for sending a message again:
 * the server accepts only inline attachments. Uses this tab's copy when it has
 * one, otherwise the image URL (usually answered from the HTTP cache).
 */
export async function materializeAttachments(
  attachments: MessageAttachment[],
  options?: { sent?: SentChatImages; fetchImage?: (url: string) => Promise<Response> }
): Promise<MessageAttachment[]> {
  if (!attachments.some((attachment) => attachment.ref && !attachment.data)) {
    return attachments;
  }
  const sent = options?.sent ?? sentChatImages;
  const fetchImage = options?.fetchImage ?? ((url: string) => fetch(url));
  return await Promise.all(
    attachments.map(async (attachment) => {
      const { ref, ...rest } = attachment;
      if (!ref || attachment.data) {
        return attachment;
      }
      const local = sent.get(attachment.id);
      if (local) {
        return { ...rest, data: local };
      }
      const response = await fetchImage(chatImageUrl(ref.id));
      if (!response.ok) {
        throw new Error(`${attachment.name} is no longer available. Attach it again.`);
      }
      return { ...rest, data: toBase64(new Uint8Array(await response.arrayBuffer())) };
    })
  );
}
