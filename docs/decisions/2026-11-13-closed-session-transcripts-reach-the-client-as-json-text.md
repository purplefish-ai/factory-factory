# Closed-session transcripts reach the client as JSON text

Originally decided on 2026-11-03 in #2854.

## Context

Archived transcripts are legacy JSON: rows may carry opaque metadata, unknown
fields and own `__proto__`, `constructor` and `prototype` keys at any depth. The
session owner's compatible reader keeps them. SuperJSON, the tRPC transformer,
rejects those reserved keys when it traverses an object it returns.

## Decision

The archive view reads `getTranscriptJson`, which returns the validated owner
DTO as JSON text, and decodes it through the same compatible schema. The object
endpoint `getTranscript` remains for ordinary data and keeps the serializer
limitation. The view's query disables structural sharing, so a changed object on
refetch keeps its reserved keys.

## Consequences

- Archived rows reach the view with every field the file holds.
- The client validates the transcript once more after decoding the text.
- Calls to `getTranscript` over the tRPC transport still cannot receive rows
  with reserved keys.
