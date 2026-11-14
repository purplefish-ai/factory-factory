# Session dispatch module

Runs a session's message queue: when the next queued message is sent, which
waiting messages share one turn, busy retries, manual resume, workspace mail
wakes, the first turn of an event-launched session, and steering a queued
message into the running turn. The [capsule guide](../../AGENTS.md) covers the
capsule, and `../../modules.ts` describes this module in one line. Bare file
names below are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

The module owns queue execution, the per-session dispatch claim, busy-turn retry
timers and attempts, manual resume, and explicit steering of a queued message.
It does not own:

- The queue, the transcript and the deltas that publish them: `../store/`.
- Starting a runtime and the lifecycle generations that fence dispatch:
  `../lifecycle/` (`SessionLifecycleGate`), passed in through
  `configureLifecycle` in `../composition/session-services.ts`.
- Sending or steering a turn on the runtime, and the turn limit: `../prompt/`,
  over `../acp/acp-steering.ts`.
- Claiming and acknowledging PR updates and workspace mail: `../delivery/`. When
  a PR update may go to a conversation:
  `src/backend/orchestration/pull-requests/`.
- The `steer_queued_message` command and its `steer_settled` reply:
  `../chat/chat-message-handlers/handlers/steer-queued-message.handler.ts`.

## Public surface

The capsule barrel exports the singleton `sessionDispatchService`, built in
`../composition/session-services.ts`, the class `SessionDispatchService` and
`EventInitialDispatchInterrupted`. Callers use `tryDispatchNextMessage`,
`steerQueuedMessage`, `steerWorkspaceMailSignal`, `setManualDispatchResume` and
`shutdown`; `sessionScope` calls `resetDispatchState` at the end of every stop
and `forgetSession` on deletion.

## Invariants

- A queued message stays in the queue, visible to viewers, until it is sent or
  rejected for good; startup and configuration awaited first do not take it out.
  `session-dispatch.service.test.ts`.
- A message is sent only when no prompt holds the session's prompt slot, checked
  again after any auto-start; background shells, subagents and goals never hold
  it. `session-dispatch.service.test.ts`.
- When the provider reports a turn already running, the batch returns to the
  queue in its order and is retried after a backoff.
  `session-dispatch.service.test.ts`, `session-dispatch.lifecycle.test.ts`.
- `steerQueuedMessage` steers only an ordinary queued human message, never a
  slash command, PR update or workspace notification.
  `session-dispatch.service.test.ts`.
- A session runs one steer at a time: a request for the same message joins it,
  one for another message fails as busy, and queue dispatch waits until it
  settles. `session-dispatch.service.test.ts`,
  `session-queued-steering.test.ts`.
- With no running turn, a steer dispatches the queue only when its message is
  the head; a stale steer of a later message is rejected.
  `session-dispatch.service.test.ts`.
- A steer that fails before its deadline, or that the provider answers with
  `promptRequired`, leaves the message queued for ordinary dispatch; an accepted
  steer takes it out of the queue even if a stop advanced the generation, so
  resume never replays it. `session-dispatch.service.test.ts`.
- A steer of a human message unacknowledged after 10 seconds stops that runtime
  before releasing the queue and leaves the message queued with no automatic
  resend, since the provider may already have consumed it.
  `../acp/acp-runtime-manager.steering.test.ts`,
  `session-dispatch.service.test.ts`.

## Map

- `session-dispatch.service.ts`: `SessionDispatchService`, the dispatch gate,
  auto-start, the prompt slot check and dispatch errors.
- `session-dispatch-batch.ts`: collects waiting messages into one turn and puts
  them back; `session-message-content.ts` builds each message's content.
- `session-dispatch-retry.ts`: busy retries; `session-dispatch-claim.ts`: queue
  progress requested while a receipt owns dispatch; `session-dispatch-gate.ts`:
  the reasons that reject a message for good.
- `session-queued-steering.ts`: explicit steering; `session-steering-errors.ts`.
- `session-mail-signal-dispatch.ts`: workspace mail wakes.
- `event-initial-dispatch.ts`: the first turn of an event-launched session.
- `session-startup-options.ts`: the startup options a queued message carries.
