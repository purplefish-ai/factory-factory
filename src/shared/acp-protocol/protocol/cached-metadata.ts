import { z } from 'zod';

/**
 * Session metadata deltas a chat client may keep across connections. The
 * server attaches a content digest to large ones; the client offers the
 * digests it holds in `load_session`, and the server then sends a
 * `cached_metadata` acknowledgement in place of a delta with matching content.
 */
export const CACHED_METADATA_DELTA_TYPES = ['slash_commands', 'config_options_update'] as const;
export type CachedMetadataDeltaType = (typeof CACHED_METADATA_DELTA_TYPES)[number];

/** Most digests one `load_session` may offer. */
export const MAX_OFFERED_METADATA_DIGESTS = 16;

/**
 * Digests are opaque to the client. The server prefixes a version (`v1:`), so
 * a changed digest scheme only misses and sends content whole.
 */
export const CachedMetadataDigestSchema = z.string().min(1).max(128);

/** The optional `load_session` field naming the metadata the client holds. */
export const CachedMetadataOfferSchema = z.object({
  digests: z.array(CachedMetadataDigestSchema).max(MAX_OFFERED_METADATA_DIGESTS),
});
export type CachedMetadataOffer = z.infer<typeof CachedMetadataOfferSchema>;
