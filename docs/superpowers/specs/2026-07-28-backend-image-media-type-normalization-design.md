# Backend Image Media-Type Normalization Design

## Context

Workspace `cms4xzahi000ix0y4zu1k8dx2` was created with an initial text prompt and
one PNG screenshot. The screenshot bytes and filename were valid, but its
persisted MIME type was an empty string. Session `cms4xzai3000jx0y41byz30zt`
started successfully and queued the initial message. When the workspace became
ready, dispatch rejected the attachment with:

```text
Unsupported image format "(unknown)". Supported formats: JPEG, PNG, GIF, WebP.
```

Because attachment processing treats that error as permanent, it removed the
whole queued message and the session remained idle with an empty transcript.

The affected process was running npm package version 0.4.2. Current `main`
already includes a client-side fix that captures clipboard MIME metadata before
the browser neuters its `DataTransferItem`. The backend still trusts the
client-supplied MIME type, so stale or malformed clients can reproduce the same
message loss.

## Goal

Make the backend derive supported image media types from image bytes so valid
PNG, JPEG, GIF, and WebP attachments remain deliverable when their declared MIME
type is empty, non-canonical, or incorrect.

## Scope

The change applies to every image attachment processed through the session
capsule, including initial workspace messages and interactive chat messages.

The change does not add support for new image formats or transcode unsupported
formats. TIFF, BMP, corrupt payloads, and arbitrary base64 remain permanent
attachment errors.

## Approach

Add a pure image format inspector next to the existing attachment processing
logic. It decodes the normalized base64 payload, recognizes the supported
format, and validates its complete container structure:

- PNG requires valid chunk boundaries and CRCs, one or more `IDAT` chunks, and
  a terminal `IEND`.
- JPEG requires bounded marker segments, a frame, scan data, and a terminal
  `EOI`.
- GIF requires bounded color tables and data blocks plus a terminal trailer.
- WebP requires a size-consistent `RIFF` container and a structurally valid
  image payload chunk.

Detection returns the canonical ACP-compatible media type:
`image/png`, `image/jpeg`, `image/gif`, or `image/webp`.

Image normalization becomes the authoritative backend operation:

1. Require attachment data.
2. Remove base64 line endings and validate the encoded form.
3. Enforce the existing 10 MiB image limit from the encoded payload rather than
   trusting the client-provided `size` field.
4. Inspect decoded bytes before consulting the declared MIME type or content
   discriminator.
5. Reject recognized but structurally invalid images and declared images whose
   bytes do not identify a supported format.
6. Return an attachment copy whose `type` is the detected canonical media type
   and whose `contentType` discriminator is `image`.

The operation does not mutate the input attachment.

`validateAttachment` will use the same operation and continue to expose its
current validation-only contract to callers. `processAttachmentsAndBuildContent`
will normalize attachments once before categorization and ACP content
construction, ensuring the detected type—not untrusted metadata—is forwarded to
the provider.

## Data Flow

```text
client attachment
  -> queue validation
  -> base64 and image-structure validation
  -> queued message
  -> dispatch processing
  -> canonical media-type normalization
  -> ACP image content
```

Initial workspace messages bypass the interactive queue handler but still enter
the same dispatch processing step, so they receive identical normalization.

## Error Handling

A valid supported image is accepted even if its declared MIME type is empty,
`image/jpg`, names a different supported format, or is mislabeled as text. The
validated bytes win over both MIME metadata fields.

An image whose decoded bytes do not match a supported signature is rejected as
a `PermanentAttachmentError` with an actionable message indicating that the
attachment does not contain supported image data. The queue retains its existing
permanent-error behavior for genuinely invalid attachments.

An image whose decoded payload exceeds 10 MiB is rejected permanently before
allocating its decoded buffer or inspecting the container.

Ordinary text attachments are unchanged; only text-labeled attachments whose
bytes form a complete supported image are reclassified.

## Testing

Extend the co-located attachment-processing tests with hand-checked fixtures:

- PNG bytes with an empty declared type normalize to `image/png`.
- JPEG bytes declared as `image/png` normalize to `image/jpeg`.
- JPEG bytes declared as `image/jpg` normalize to `image/jpeg`.
- Valid GIF and WebP structures produce their canonical media types.
- Valid image bytes labeled `text/plain` or `contentType: text` are still
  dispatched as images.
- Truncated PNG, JPEG, GIF, and WebP payloads are rejected permanently.
- A PNG with a corrupt chunk checksum is rejected permanently.
- PNG headers with invalid color type and bit-depth combinations are rejected.
- Animated WebP frames require an animation-flagged `VP8X` header followed by
  `ANIM` and one or more `ANMF` chunks in order.
- Image payloads over 10 MiB are rejected before complete decoding, including
  supported image signatures carrying forged text metadata and `size` values.
- Arbitrary valid base64 that is not a supported image is rejected permanently.
- Existing line-wrapped base64 behavior remains accepted.
- Text attachment behavior remains unchanged.

The primary regression assertion exercises
`processAttachmentsAndBuildContent`, because message delivery—not the detector's
private implementation—is the user-visible contract. A focused test run will be
followed by type checking and the repository guardrails.

## Alternatives Considered

Repairing only workspace creation metadata was rejected because ordinary chat
messages and stale clients would retain the same failure.

Dropping invalid attachments while delivering only their text was rejected
because it silently loses user-provided context and hides corrupt payloads.

Adding `sharp` or a browser TIFF decoder was rejected because this fix only
needs to recover already-supported formats with inaccurate metadata; format
conversion is outside scope.
