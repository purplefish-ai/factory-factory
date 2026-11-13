# Chat frames are validated in full, replay element by element

Originally decided on 2026-11-09 in #3116.

## Context

The chat client validates every server frame before load bookkeeping or the
reducer sees it. Validation could check only a frame's envelope and trust its
arrays, or parse everything, and a failure could reject a whole frame or only
the invalid part.

## Decision

Every snapshot and replay array is parsed in full; there is no cheaper envelope
check. Parsing a replay of 1,000 agent messages (about 1 MB of JSON) took about
3 ms in Node, with or without Zod's JIT; `JSON.parse` of the same frame took
about 1.6 ms.

Snapshots, deltas and live events are all-or-nothing. A replay batch is the one
exception: each replay event that fails the schema is dropped and reported on
its own, so one malformed historical event cannot make a session unloadable.

## Consequences

- An invalid frame is logged with its Zod issues and shown as one error toast;
  it never reaches the reducer.
- A replay can hydrate with some historical events missing; the console names
  them and the same error toast appears.
- A replay containing an invalid event is parsed about three times: whole, event
  by event, then whole again without the dropped events.
- Replay reassembly is not covered by the exception: a chunked replay whose
  fragments do not decode, or that arrives incomplete, is dropped whole.
