# Session events module

Applies what an ACP runtime reports to the session: provider updates to the
transcript and runtime state, permission requests to the queue of requests shown
to the user, and subagent changes to viewer notifications. The
[capsule guide](../../AGENTS.md) covers the capsule, and `../../modules.ts`
describes this module in one line. This guide so far covers permission requests,
subagent notifications and a failed turn's error. Bare file names below are in
this directory; paths that start with `src/` are from the repository root.

## Owns, and does not own

The module owns each session's permission bridge, which requests are answered
automatically, which pending request the user is shown, the throttling of
subagent notifications, and keeping a failed turn's error through background
activity. It does not own:

- The permission bridge itself, elicitation forms and the runtime's handlers:
  `../acp/acp-permission-bridge.ts`, `../acp/acp-elicitation.ts`.
- The pending request kept for replay: `../store/`. It lives in memory, so it
  survives a viewer reconnect while the session exists but not a server restart.
- The user's reply: the `permission_response` handler in `../chat/`.
- Cancelling a session's pending requests when it stops or is deleted: the
  `sessionScope` participant in `../lifecycle/session-scope.ts`.
- The child sessions, their transcripts and activity:
  `../acp/acp-native-session-tracker.ts`.
- Translating provider updates into transcript deltas:
  `src/shared/acp-protocol/session-update-translator.ts`.

## Public surface

The capsule barrel exports the singletons `acpEventProcessor` and
`sessionPermissionService`, built in `../composition/session-core-services.ts`.

## Invariants

- When permission requests overlap, the newest is shown, and answering it shows
  the newest one still waiting; an answer to an older or unknown request never
  clears the one shown. `session.permission.service.test.ts`.
- A turn that ended with a provider error keeps the session in its error state
  while background tasks start and stop.
  `acp-event-processor.subagents.test.ts`.
- A subagent's `updated` notifications are sent at most once every 250 ms,
  `created` and `completed` at once, and clearing the session's state sends the
  pending ones. `subagent-change-coalescer.test.ts`,
  `acp-event-processor.subagents.test.ts`.

## Map

- `acp-event-processor.ts`: `AcpEventProcessor`, one runtime event handler per
  session; `acp-replay-policy.ts` decides which events replay suppression drops,
  and `acp-thought-buffer.ts` buffers thought chunks.
- `session.permission.service.ts`: bridges and the shown request.
- `subagent-change-coalescer.ts`: subagent notifications;
  `subagent-tool-events.ts` collects a subagent's tool calls for interceptors.
- `session-work-state.ts`: the runtime's work state.
