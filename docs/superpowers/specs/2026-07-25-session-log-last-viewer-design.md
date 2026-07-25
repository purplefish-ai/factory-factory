# Session Log Last-Viewer Closure Design

## Problem

The chat WebSocket close handler owns a session-scoped debug logger but currently closes that
logger for every active connection that disconnects. Multiple connection IDs can view the same
session, so closing one viewer marks the shared logger closed and silently drops later entries from
the remaining viewers.

The handler also calls `closeSession` before unregistering the closing socket. At that point
`ChatConnectionRegistry.countViewers` still includes the socket being closed, so the existing
viewer-count API cannot distinguish the last viewer until registry removal has happened.

## Considered Approaches

1. Unregister the active socket first and close the session logger only when the post-unregister
   viewer count is zero. This is selected because the registry remains the source of truth, the
   change matches existing session cleanup semantics, and it requires no new state.
2. Check whether the pre-unregister viewer count is one. This could work synchronously, but it
   encodes the closing socket's membership as an implicit assumption and makes the ordering harder
   to reason about.
3. Add a separate logger reference count. This duplicates connection-registry state and introduces
   a second lifecycle that could drift from the actual viewers.

## Design

Within the existing active-socket identity guard, unregister the closing connection before any
viewer-count decision. If the connection has a session ID, write the existing `connection_closed`
entry and call `closeSession` only when `countViewers(dbSessionId)` returns zero.

Logging remains before logger closure so the last viewer's close event is recorded. A non-final
viewer records the same close event without ending the shared log. The existing
`clearSessionIfDisconnectedAndInactive` call remains after unregistering and continues to see the
accurate post-disconnect viewer count.

No registry, logger, schema, API, or UI changes are required.

## Edge Cases

- Closing one of two different connection IDs for the same session leaves one viewer registered and
  must not close the session log.
- Closing the final viewer removes the last registry subscription and closes the session log once.
- A stale socket close after the same connection ID has been replaced remains ignored by the
  existing `current?.ws === ws` guard, so it neither unregisters the replacement nor closes the log.
- Connections without a session ID continue to unregister without invoking the session logger.
- In-flight message cleanup continues to wait for message handling and uses the same post-unregister
  viewer count.

## Testing

Add a handler regression test that opens two sockets with distinct connection IDs for one session.
After closing the first socket, assert that the registry reports one viewer and `closeSession` has
not run. Then close the second socket and assert that the registry reports zero viewers and
`closeSession` ran exactly once for that session.

Run the focused handler test through a red-green cycle, followed by:

```bash
pnpm typecheck && pnpm check:fix && pnpm test && pnpm build
```
