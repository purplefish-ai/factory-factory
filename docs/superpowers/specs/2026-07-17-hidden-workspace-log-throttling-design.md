# Hidden Workspace Log Throttling Design

## Goal

Keep dev-log and post-run-log connections, status indicators, and buffered
history accurate while preventing hidden streams from committing every chunk to
React state or scheduling scroll work.

## Scope

This change applies to the two push-only workspace log streams rendered by
`RightPanel`: `/dev-logs` and `/post-run-logs`. It does not change WebSocket
connection, validation, reconnect, or server replay behavior. Setup logs and
terminal output keep their existing implementations.

## Design Options

1. **Hook-local bounded buffer with visibility-aware presentation (selected).**
   Each `useLogStream` instance owns a non-React rolling chunk buffer and accepts
   whether its panel is visible. Transport callbacks always append to the
   buffer, while React output updates are scheduled only for the visible stream.
   This is the smallest boundary that preserves the existing shared connection
   and status API.
2. **Disconnect hidden streams.** This would eliminate hidden traffic but would
   weaken connection indicators, force reconnects on tab changes, and depend on
   replay timing to avoid gaps.
3. **Introduce a shared external log store.** This could support multiple
   subscribers but adds lifecycle and subscription machinery that the current
   single `RightPanel` consumer does not need.

## Architecture

Extend `rolling-output.ts` with a mutable bounded chunk buffer. Appends update
an array-backed queue and retained character count without joining the entire
rolling output. When the cap is crossed, the buffer drops complete leading
chunks and slices at most one partial leading chunk, then prepends the existing
workspace truncation marker in snapshots. Consumed queue slots are compacted
periodically so discarded strings are released.

`useLogStream` receives an `isVisible` argument. WebSocket message and lifecycle
callbacks append output, connection, disconnection, and reconnection text to the
buffer regardless of visibility. `connected` and `hasDisconnected` remain
ordinary lightweight React state supplied to the tab indicators.

For a visible stream, the first pending append schedules one 100 ms flush.
Additional chunks before that deadline only update the buffer. The flush joins
the current bounded snapshot once and commits it to React. A hidden stream does
not schedule a flush. When visibility becomes true, a layout effect immediately
hydrates React output from the current buffer without reconnecting.

The hook cancels pending flushes when hidden, when the workspace/endpoint
identity changes, and on unmount. The rolling buffer is recreated for a new
workspace/endpoint identity so output cannot leak between workspaces.

## Scrolling

Scrolling is driven by committed visible output, not by transport chunks. After
a non-empty visible output commit, an effect schedules one
`requestAnimationFrame` callback that scrolls the end marker into view. A newer
commit or cleanup cancels the old frame. Hidden output never requests a frame or
calls `scrollIntoView`.

## Error and Lifecycle Behavior

- Schema-invalid and empty output messages remain ignored.
- Connection and disconnection announcements use the same bounded buffer and
  retain their existing wording.
- Connection indicators update while the stream is hidden.
- Reconnect behavior remains owned by `useWebSocketChannel` and does not depend
  on active-tab state.
- Pending timeouts and animation frames are canceled during unmount.

## Testing

Add rolling-buffer unit tests with a small cap to verify normal appends, newest
output retention, single-marker semantics, oversized chunks, and zero capacity.

Expand the hook tests to verify:

- a high-frequency hidden burst causes no output render and no scroll
- opening a hidden stream synchronously hydrates all buffered output without a
  new connection URL
- a visible burst produces one throttled output commit and one frame-aligned
  scroll
- disconnect and reconnect messages buffer while hidden while indicator state
  remains current
- invalid messages remain ignored
- visibility changes and unmount cancel pending timeouts and animation frames

Run the focused workspace tests, then `pnpm typecheck`, `pnpm check:fix`,
`pnpm test`, and `pnpm build`.
