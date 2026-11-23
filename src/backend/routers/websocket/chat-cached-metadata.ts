import { createHash } from 'node:crypto';
import type { SessionDeltaEvent, WebSocketMessage } from '@/shared/acp-protocol';
import {
  CACHED_METADATA_DELTA_TYPES,
  type CachedMetadataDeltaType,
} from '@/shared/acp-protocol/protocol/cached-metadata';

/**
 * Below this size a delta goes out whole: the acknowledgement and the digest
 * would save little or nothing.
 */
const MIN_CACHEABLE_DELTA_BYTES = 1024;
const DIGEST_VERSION = 'v1';

/** The two ways one metadata delta can reach a viewer. */
export interface CacheableMetadataFrames {
  digest: string;
  /** The delta with its digest, for viewers that do not hold it. */
  full: string;
  /** A `cached_metadata` acknowledgement, for viewers that offered the digest. */
  acknowledgement: string;
}

type CacheableDelta = Extract<SessionDeltaEvent, { type: CachedMetadataDeltaType }>;

function isCacheableDelta(event: SessionDeltaEvent): event is CacheableDelta {
  return CACHED_METADATA_DELTA_TYPES.some((type) => type === event.type);
}

/**
 * Digest a large slash command or config option delta. The digest covers the
 * delta's serialized content, so equal content in another session, provider
 * or server process yields the same digest. Returns null for other frames
 * and for a payload published with its own serialization, which is sent as-is.
 */
export function prepareCacheableMetadata(
  payload: WebSocketMessage,
  serialized?: string
): CacheableMetadataFrames | null {
  if (
    serialized !== undefined ||
    payload.type !== 'session_delta' ||
    !isCacheableDelta(payload.data)
  ) {
    return null;
  }
  const { digest: _previous, ...content } = payload.data;
  const body = JSON.stringify(content);
  if (Buffer.byteLength(body) < MIN_CACHEABLE_DELTA_BYTES) {
    return null;
  }
  const digest = `${DIGEST_VERSION}:${createHash('sha256').update(body).digest('base64url')}`;
  const acknowledgement: WebSocketMessage = {
    type: 'session_delta',
    data: { type: 'cached_metadata', deltaType: content.type, digest },
  };
  return {
    digest,
    full: JSON.stringify({ type: 'session_delta', data: { ...content, digest } }),
    acknowledgement: JSON.stringify(acknowledgement),
  };
}
