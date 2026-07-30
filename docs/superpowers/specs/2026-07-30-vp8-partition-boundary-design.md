# VP8 Partition Boundary Validation Design

## Context

The WebP validator reads the VP8 keyframe's `first_part_size` from the
three-byte frame tag, but compares it with `dataLength - 3`. A VP8 keyframe
places its first partition after the complete ten-byte uncompressed header:
the frame tag, start code, width, and height. Subtracting only the frame tag
allows a malformed chunk to claim up to seven bytes more partition data than
the chunk contains.

## Goal

Reject VP8 keyframes whose declared first partition does not fit after the
ten-byte keyframe header, while preserving acceptance of existing valid WebP
images.

## Approach

Keep the image-inspection API and WebP parsing flow unchanged. In
`isValidVp8Chunk`, compare `firstPartitionLength` with `dataLength - 10`.

Add a regression test through the public `validateAttachment` boundary. The
test constructs a size-consistent RIFF/WebP container with a 20-byte `VP8 `
payload, a valid keyframe header, ten payload bytes, and a declared
`first_part_size` of 14. The container passes RIFF checks but must fail VP8
validation because only ten bytes remain after the header.

## Error Handling

The malformed payload remains recognizable as WebP, so attachment validation
rejects it with the existing `PermanentAttachmentError` path for structurally
invalid supported image data. No new error type or message is required.

## Testing

- Verify the malformed 20-byte VP8 payload is rejected.
- Keep the existing production-encoded WebP fixture as coverage that valid
  WebP remains accepted.
- Run the focused attachment-processing test, type checking, formatting and
  lint fixes, the full Vitest suite, and the production build.

## Alternatives Considered

Exporting `isValidVp8Chunk` for a direct unit test was rejected because it
would widen the module API only for tests. Adding a general WebP fixture
framework was rejected because one small test-local binary builder expresses
this boundary without introducing unrelated abstraction.
