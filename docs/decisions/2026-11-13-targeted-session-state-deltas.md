# Queue, commit and request changes publish targeted deltas

Originally decided on 2026-11-03 in #2869.

## Context

Queue, commit and interactive-request changes published a full
`session_snapshot`. A snapshot rebuilds, serializes and resends the whole
renderer transcript window, up to 1,000 messages, to every viewer.

## Decision

These changes publish small `session_delta` events instead: `queue_updated`,
`transcript_message_committed` and `pending_request_updated`. Each carries the
authoritative value of the state it changes (the complete queue, the committed
entry with the queue that remains, the current request or `null`), so the client
replaces that state rather than patching it, and applying a delta matches what a
snapshot would show for those fields.

## Consequences

- Ordering relies on the per-viewer FIFO delivery every other delta uses: the
  domain mutates the store and publishes synchronously, and a viewer that is
  loading receives these deltas after its replay.
- Full snapshots remain for changes that rewrite the transcript, such as process
  exit, clearing queued work, provider-history reset, transcript removal and
  PR-delivery queue changes that also rewrite a transcript entry. A snapshot for
  a session nobody is viewing is not built; load replies are always sent.
