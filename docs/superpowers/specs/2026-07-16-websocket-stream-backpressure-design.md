# WebSocket Stream Backpressure Design

## Goal

Bound server-side WebSocket buffering for high-volume terminal and log streams,
while preserving existing connection and replay behavior and making asynchronous
send failures visible.

## Scope

Apply the policy to live output messages from:

- workspace terminals
- setup terminals
- dev-server logs
- post-run logs

The policy does not apply to low-volume control messages such as terminal
creation, exit, errors, or restoration payloads. It also does not introduce the
larger `TopicBroadcaster` abstraction proposed in issue #1872.

## Design

Extend the shared WebSocket send utilities with a high-volume stream sender.
Before sending, the helper checks that the socket is open and compares the
projected queued bytes (`ws.bufferedAmount` plus the UTF-8 message byte length)
with a fixed 1 MiB threshold. If the projected amount is above the threshold,
the new output chunk is dropped instead of being added to the socket's send
queue.

Dropping is tracked per socket as a congestion window. The helper logs one
warning when it first begins dropping chunks, suppresses repeated warnings
while the socket remains congested, and clears the congestion state when a
later send observes that the queued amount has fallen to or below the
threshold. This bounds log volume as well as socket buffering.

Successful sends use the `ws.send` callback. Callback errors are normalized and
logged, covering asynchronous failures that the existing synchronous
`try/catch` helper cannot observe. Synchronous exceptions remain caught and
logged.

The shared dev-log and post-run-log handler factory uses the new helper for live
output. The workspace terminal and setup-terminal handlers use it only in their
PTY output callbacks. Existing `safeSend` behavior for other fan-out paths is
unchanged.

## Recovery Behavior

The server does not build a second application-level queue for dropped output:

- Workspace terminals already retain bounded rolling output and replay it when
  the client reconnects.
- Dev and post-run logs already retain bounded output buffers and send them on
  reconnect.
- Setup terminals are connection-scoped and have no replay buffer, so a slow
  client may miss output while congested. This is preferable to unbounded
  process memory growth for an auxiliary setup flow.

The helper resumes live streaming automatically once the current buffer has
enough capacity for the next output message. No browser protocol changes are
required.

## Error Handling

- Non-open sockets do not receive output.
- Synchronous `ws.send` failures are logged and reported as unsuccessful.
- Asynchronous send callback failures are logged.
- A congested socket produces at most one warning until it recovers.
- Congestion on one connection does not pause a PTY or affect healthy
  connections subscribed to the same terminal or log stream.

## Testing

Add unit tests for the shared helper that verify:

- normal stream output is sent with a callback
- output is dropped when its UTF-8 bytes would push the queue above 1 MiB
- only one warning is emitted during a congestion window
- sending resumes after the socket drains
- synchronous and callback send errors are logged
- closed sockets are ignored

Add handler regression tests proving that terminal, setup-terminal, and the
shared push-channel path do not send live output while the socket is above the
threshold and resume after it drains. Because dev and post-run logs share the
factory, one focused factory-path integration test plus the existing channel
tests is sufficient to cover both log channels.

Run the focused Vitest files, then `pnpm typecheck`, `pnpm check`, and the full
`pnpm test` suite.
