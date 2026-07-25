# Chat Error Order Namespace Design

## Problem

The chat reducer currently assigns a locally generated `WS_ERROR` message the next apparent
transcript order (`maxOrder + 1`). Backend assistant streaming independently allocates that same
non-negative order. Because `applyRendererMessages` indexes every agent message by order, the first
`WS_ASSISTANT_TEXT_DELTA` finds the local error at its backend order, detects a different message ID,
and rejects the delta. Later deltas for that assistant message cannot create the missing bubble, so
the response remains invisible until replay.

## Considered Approaches

1. Put local transport errors in a negative order namespace and omit negative orders from the agent
   order index. This is selected because backend protocol validation already reserves non-negative
   orders, the error remains in the renderer message list, and the stable-ID guard for real agent
   messages stays intact.
2. Teach `handleAssistantTextDelta` to replace or bypass a non-assistant message at a colliding
   order. This treats the symptom at the consumer and risks hiding a legitimate backend identity
   mismatch or displacing the visible error.
3. Allocate local errors from a different positive sequence. Any client-computed positive value can
   eventually overlap an independently allocated backend order, so this does not establish a real
   ownership boundary.

## Design

Define a module-local `ERROR_MESSAGE_ORDER` sentinel with value `-1` in the message transport
slice. `WS_ERROR` continues to add the error message and clear a loading session status exactly as
it does today, but it no longer inspects transcript orders or claims a backend order.

When `applyRendererMessages` rebuilds `agentMessageOrderToIndex`, it indexes only agent messages
whose order is non-negative. Negative local messages remain renderable and remain eligible for the
normal renderer transcript limit, but backend message upserts and assistant deltas cannot resolve
to them.

Renderer sorting and client binary insertion compare negative local orders as the live transcript
tail. This preserves the array ordering invariant for later backend inserts, keeps a newly received
error inside a full renderer window, and ensures a following backend message is inserted immediately
before the local error. Multiple negative local messages retain arrival order through stable sorting.

No backend, wire-protocol, message-schema, or React component changes are required; the shared
renderer-window ordering utility owns the local-tail comparison.

## Data Flow

1. Replay installs backend messages at orders 0 through 7 and indexes those orders.
2. `WS_ERROR` adds a visible local error at order -1; renderer normalization keeps it at the live
   transcript tail and rebuilding indexes omits -1.
3. The first assistant text delta arrives with backend order 8 and offset 0.
4. The order lookup misses, so the reducer creates the assistant message with its stable backend ID
   immediately before the local error.
5. Rebuilt indexes point order 8 at the assistant message, allowing all later deltas to extend it.

## Edge Cases

- Multiple errors may share the negative sentinel because local errors are never addressed by
  backend order; each remains a distinct rendered message by ID. Stable sorting retains their
  relative arrival order at the live transcript tail.
- An error received while loading still moves the session status to ready.
- Existing non-negative message upsert, duplicate-delta, overlap, gap, and identifier mismatch
  behavior remains unchanged.
- Renderer trimming still applies to local errors; the order index is rebuilt from retained
  non-negative backend messages only.
- At the renderer transcript limit, the oldest backend messages are trimmed while the newly arrived
  error and following assistant delta remain visible and correctly indexed.

## Testing

Add a reducer regression test that replays backend orders 0 through 7, dispatches `WS_ERROR`, then
dispatches the first `WS_ASSISTANT_TEXT_DELTA` at order 8. The test must prove the error has a
negative order and is absent from `agentMessageOrderToIndex`, while the assistant text is visible
under its stable ID and order 8 is indexed to it.

Repeat the sequence with a replay at `DEFAULT_RENDERER_TRANSCRIPT_LIMIT` and prove both the local
error at the tail and the following backend assistant message survive trimming.

Run the focused reducer test through a red-green cycle, followed by:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```
