import { z } from 'zod';

/**
 * Chat images the server sends as references instead of inline base64.
 *
 * A reference names the image by the SHA-256 of its media type and base64
 * bytes, so its URL never changes meaning: the browser fetches it once from
 * `chatImageUrl(id)`, keeps it in the HTTP cache, and later session loads,
 * replays and deltas carry only the reference. What the agent receives, and
 * what the server stores, stays inline base64.
 */
export const CHAT_IMAGE_ROUTE = '/api/chat-images';

/** Raster types the image endpoint serves; anything else stays inline. */
export const CHAT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export const ChatImageMediaTypeSchema = z.enum(CHAT_IMAGE_MEDIA_TYPES);
export type ChatImageMediaType = z.infer<typeof ChatImageMediaTypeSchema>;

/** Lowercase hex SHA-256: 64 characters, nothing that could form a path. */
export const CHAT_IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;

const dimension = z.number().int().positive().max(1_000_000);

export const ChatImageRefSchema = z.object({
  id: z.string().regex(CHAT_IMAGE_ID_PATTERN),
  /** Decoded size in bytes. */
  size: z.number().int().nonnegative(),
  width: dimension.optional(),
  height: dimension.optional(),
});

export type ChatImageRef = z.infer<typeof ChatImageRefSchema>;

/** The immutable URL of a referenced image. */
export function chatImageUrl(id: string): string {
  return `${CHAT_IMAGE_ROUTE}/${id}`;
}
