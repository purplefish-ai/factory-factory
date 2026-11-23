import type { ChatImageMediaType } from '@/shared/chat-image-ref';

export interface StoredChatImage {
  mediaType: ChatImageMediaType;
  /** Base64, usually the same string the session transcript holds. */
  data: string;
  /** Decoded size in bytes. */
  size: number;
}

/**
 * Base64 characters kept for images no transcript may still hold. While a
 * session is loaded its transcript already holds each string, so an entry
 * costs only its map slot; this bounds what outlives an evicted session.
 */
const DEFAULT_MAX_CHARS = 128 * 1024 * 1024;

/**
 * The images the chat transport has sent as references, by content id, for
 * the chat image endpoint to serve. In memory only: every reference a client
 * receives was registered when it was sent, and a reference a client still
 * holds after a restart or eviction is registered again by its next load.
 * Why: docs/decisions/2026-11-23-chat-images-travel-as-references.md.
 */
export class ChatImageStore {
  private readonly images = new Map<string, StoredChatImage>();
  private readonly maxChars: number;
  private chars = 0;

  constructor(options?: { maxChars?: number }) {
    this.maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  }

  /** Add or refresh an image, evicting the least recently used beyond the budget. */
  put(id: string, image: StoredChatImage): void {
    const existing = this.images.get(id);
    if (existing) {
      this.images.delete(id);
      this.chars -= existing.data.length;
    }
    this.images.set(id, image);
    this.chars += image.data.length;
    for (const [oldestId, oldest] of this.images) {
      if (this.chars <= this.maxChars || oldestId === id) {
        break;
      }
      this.images.delete(oldestId);
      this.chars -= oldest.data.length;
    }
  }

  get(id: string): StoredChatImage | undefined {
    const image = this.images.get(id);
    if (image) {
      this.images.delete(id);
      this.images.set(id, image);
    }
    return image;
  }
}
