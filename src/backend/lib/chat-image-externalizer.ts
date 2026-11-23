import { createHash } from 'node:crypto';
import type { ChatImageMediaType, ChatImageRef } from '@/shared/chat-image-ref';
import { type InspectedChatImage, inspectChatImage } from './chat-image-inspection';
import type { ChatImageStore } from './chat-image-store';

type ImageAnalysis = { data: string; image: (InspectedChatImage & { id: string }) | null };

/**
 * Hashing and inspecting a large image costs milliseconds, so each result is
 * kept on the object that holds the bytes: the transcript reuses those objects
 * across loads, snapshots and deltas. The data string is compared too, in case
 * an object is ever edited in place.
 */
const analyses = new WeakMap<object, ImageAnalysis>();

/** Deeper than any chat payload; JSON serialization would fail long before. */
const MAX_DEPTH = 64;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function analyze(owner: object, data: string): ImageAnalysis['image'] {
  const cached = analyses.get(owner);
  if (cached?.data === data) {
    return cached.image;
  }
  const inspected = inspectChatImage(data);
  const image = inspected && {
    ...inspected,
    id: createHash('sha256').update(`${inspected.mediaType}\n`).update(data).digest('hex'),
  };
  analyses.set(owner, { data, image });
  return image;
}

/** The reference for some bytes, registering them so the endpoint can serve it. */
function reference(
  owner: object,
  data: string,
  store: ChatImageStore
): { ref: ChatImageRef; mediaType: ChatImageMediaType } | null {
  const image = analyze(owner, data);
  if (!image) {
    return null;
  }
  const { id, mediaType, size, width, height } = image;
  // Every send registers again: the store may have evicted an earlier one.
  store.put(id, { mediaType, data, size });
  return { ref: { id, size, ...(width && height ? { width, height } : {}) }, mediaType };
}

/** `{ type: 'image', source: { type: 'base64', ... } }`, as tool results and prompts carry it. */
function externalizeImageBlock(block: JsonRecord, store: ChatImageStore): JsonRecord | null {
  const source = block.source;
  if (
    block.type !== 'image' ||
    !isRecord(source) ||
    source.type !== 'base64' ||
    typeof source.data !== 'string'
  ) {
    return null;
  }
  const image = reference(source, source.data, store);
  return image && { ...block, source: { type: 'ref', media_type: image.mediaType, ...image.ref } };
}

/** A `MessageAttachment` holding an image. Text attachments keep their content. */
function externalizeAttachment(value: unknown, store: ChatImageStore): unknown {
  if (
    !isRecord(value) ||
    typeof value.data !== 'string' ||
    value.contentType === 'text' ||
    (value.contentType !== 'image' &&
      !(typeof value.type === 'string' && value.type.startsWith('image/')))
  ) {
    return value;
  }
  const image = reference(value, value.data, store);
  return image ? { ...value, data: '', ref: image.ref } : value;
}

function mapArray(values: unknown[], map: (value: unknown) => unknown): unknown[] {
  let copy: unknown[] | null = null;
  values.forEach((value, index) => {
    const next = map(value);
    if (next !== value) {
      copy ??= [...values];
      copy[index] = next;
    }
  });
  return copy ?? values;
}

function externalize(value: unknown, store: ChatImageStore, depth: number): unknown {
  if (depth > MAX_DEPTH || typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return mapArray(value, (item) => externalize(item, store, depth + 1));
  }
  if (!isRecord(value)) {
    return value;
  }
  const image = externalizeImageBlock(value, store);
  if (image) {
    return image;
  }
  let copy: JsonRecord | null = null;
  for (const key of Object.keys(value)) {
    const child = value[key];
    const next =
      key === 'attachments' && Array.isArray(child)
        ? mapArray(child, (attachment) => externalizeAttachment(attachment, store))
        : externalize(child, store, depth + 1);
    if (next !== child) {
      copy ??= { ...value };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

/**
 * Replace the image bytes in a server-to-client chat payload with references
 * (`@/shared/chat-image-ref`), registering each image in `store` for the chat
 * image endpoint. Image attachments become `{ ..., data: '', ref }` and image
 * blocks become `{ type: 'image', source: { type: 'ref', ... } }`; text
 * attachments and anything that is not a PNG, JPEG, GIF or WebP stay inline.
 *
 * Copy on write: the input, which is usually the live transcript, is never
 * mutated, and a payload without images is returned as the same object.
 */
export function externalizeChatImages<T>(value: T, store: ChatImageStore): T {
  // Each replacement is a member of the same wire type it replaces (an
  // attachment with `ref`, or a `ref` image source), so the shape is kept.
  return externalize(value, store, 0) as T;
}
