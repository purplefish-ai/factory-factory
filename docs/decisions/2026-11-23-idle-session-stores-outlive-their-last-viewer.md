# Idle session stores outlive their last viewer

## Context

When the last chat socket viewing a session closed and no runtime was running,
the chat handler cleared the session's in-memory store at once. The next
`load_session` then rebuilt it: from the provider history projection cache if
the file was unchanged and the entry still within its five-minute TTL, otherwise
by reading and parsing the JSONL file. The owner switches between many sessions
from a phone, and a phone also drops the socket each time the app goes to the
background, so most switches back paid for that rebuild.

Measured on this machine's own Claude histories, with a harness that runs the
real load path (`executeSessionLoad`, the provider history hydrator, replay
framing) against files of 2.3 to 70.7 MB: switching back took 24 to 56 ms on a
cache hit and 64 to 309 ms on a file read; replaying a kept store took 5 to 11
ms, including the history file `stat` described below. A later resume cursor
(store epoch and revision) also only matches while the store survives.

## Decision

`SessionStoreRetention` (`src/backend/services/session/service/store/`) keeps a
store for 10 minutes after its last viewer leaves, and keeps at most 12 such
stores; releasing a 13th clears the one released longest ago. The owner chose
both numbers.

- Only a store whose history hydration finished is kept; any other is cleared at
  once, as before.
- A load claims the store and ends its countdown. So does any write that puts
  the store to use (`getOrCreateActive`), which hands it back to the owners that
  cleared it before: the next viewer to leave, or the workflow finalizer when a
  runtime stops. When the countdown ends, the chat handler's condition (no
  running runtime, no viewer) is checked again before the store is cleared.
- Every clear still goes through `SessionDomainService.clearSession`, so
  `session_cleared` and the projection cache's TTL start when the store is
  actually cleared. `clearSession`, `clearAllSessions`, permanent deletion and
  the `forget` stage end the countdown; the `session-stores` shutdown step
  clears every kept store and makes later releases clear at once.
- A store records the history file identity (path, size, modification time,
  inode) its hydration projected. A load that claims a kept store, while no
  runtime is alive, compares it with the file now and discards the store when it
  differs, is gone, or was never identified, so a session resumed by another
  client is read again. A concurrent load of the same session waits for that
  check.

## Consequences

- Memory. A kept store holds the projected transcript: about a third of the
  history file's size on the heap for large files (24.2 MB for the 70.7 MB file,
  7.8 MB for 28.9 MB, 1.4 MB for 2.3 MB). While its projection is still in the
  provider history cache the two share every message; the store's own copies of
  the rows and its index added 0.1 to 0.8 MB. The cache is bounded by 128 MB of
  file size, so large sessions fall out of it and a kept store then holds them
  alone. Twelve median sessions (2.4 MB files) hold about 15 MB; the worst case
  is twelve of the largest transcripts, about 125 MB for the twelve largest
  Claude histories here (371 MB of JSONL). No store is bounded by size.
- A store kept after its runtime stopped has seen that run, so its file has
  changed and the next load reads the file again; this matches the previous
  behaviour and keeps the store from going stale.
- Queued work in a kept store, which the disconnect used to drop, now lasts up
  to 10 minutes and holds an application update until it is cleared.
- Rebuilding a Claude session from an unchanged file produced the same row IDs
  and orders in every measured session; a kept store keeps them by construction,
  including rows added live.
- The tests that hold this:
  `src/backend/services/session/service/store/session-store-retention.test.ts`,
  `src/backend/services/session/service/chat/session-load.service.test.ts`,
  `src/backend/routers/websocket/chat-load.handler.test.ts` and
  `src/backend/application-shutdown.test.ts`.
