# Durable Session Stop Reasons Design

## Goal

Make every interrupted turn and stopped agent session explain itself in the chat
transcript, including after refreshes and server restarts, and increase the
standard user-turn timeout from one hour to four hours.

The motivating failure was a healthy Codex turn that reached Factory Factory's
one-hour prompt deadline. The backend logged the timeout and briefly held an
in-memory error, but no chat client was connected. Failed-message replay expired
after 60 seconds, and reconnect projected the still-alive ACP process as idle,
so the user saw work stop without an explanation.

## Approaches Considered

1. Persist append-only session lifecycle events and merge them into provider
   history. This is the selected approach because it preserves chronology,
   supports multiple stops in one resumable session, survives process and
   server restarts, and does not modify provider-owned transcript files.
2. Store only the latest stop reason on `AgentSession`. This would be simpler,
   but it would provide a status banner rather than a chat log and would discard
   earlier interruptions.
3. Emit a synthetic WebSocket message. This is the smallest change, but it
   repeats the current defect: clients disconnected at the time of failure
   never receive it, and refresh loses it.

## Persistence Model

The session service capsule will own a new append-only
`SessionLifecycleEvent` Prisma model. An event belongs to a workspace and is
identified logically by `sessionId`, rather than by a foreign key to
`AgentSession`, so it survives moving an active session into `ClosedSession`.
Deleting the workspace cascades to its lifecycle events.

Each row contains:

- a generated `id`;
- `workspaceId` and `sessionId`;
- a typed event kind: `TURN_INTERRUPTED` or `SESSION_STOPPED`;
- a typed reason: `PROMPT_TIMEOUT`, `PROVIDER_ERROR`, `USER_STOP`,
  `SESSION_CLOSED`, `WORKSPACE_ARCHIVED`, `UNEXPECTED_EXIT`, or
  `SYSTEM_STOP`;
- a human-readable message suitable for the chat transcript;
- a caller-stable `dedupeKey`;
- `createdAt`.

`[sessionId, dedupeKey]` is unique. The table is indexed by
`[sessionId, createdAt]` and by `workspaceId`. Model ownership and dependency
checks are updated in the service registry.

The message is persisted with the event so wording remains stable for old chat
logs. The typed reason remains available for styling and future filtering.

## Event Recording

A focused session lifecycle-event service will write the database row first,
then append the corresponding structured chat message to an active in-memory
transcript and emit the normal agent-message delta. A duplicate insert resolves
to the existing row and idempotently upserts its stable transcript message,
emitting a delta only when that message was not already present.

Prompt execution receives a stable attempt key when
`AcpEventProcessor.beginPromptTurn` starts the turn. All failure paths for that
attempt use `turn:<attempt-key>:stop` as their dedupe key. This prevents a
provider error reported through an ACP message and the resulting rejected
prompt promise from creating two transcript entries.

The recorder covers:

- the four-hour prompt deadline;
- provider/API failures, retaining useful public details such as HTTP 529 and
  “Overloaded” when the provider supplies them;
- explicit user stop;
- session close;
- workspace archive or other system-initiated shutdown;
- unexpected ACP process exit, including its exit code when available.

An explicit stop suppresses the secondary prompt-cancellation failure for the
same turn. An unexpected process exit may follow a provider turn error; these
are separate facts only when both add information. Deliberate shutdown does not
also emit an unexpected-exit event.

Messages use concise copy:

- `Turn stopped: reached the 4-hour limit.`
- `Turn stopped: Codex returned HTTP 529 (Overloaded).`
- `Session stopped by you.`
- `Session stopped because the workspace was archived.`
- `Session stopped: agent process exited unexpectedly (code 1).`

Unknown internal failures use a safe generic message in chat while their full
details remain in server logs.

## Transcript Hydration and Closed Sessions

The shared chat protocol gains a structured `session_lifecycle` agent-message
variant containing event id, kind, reason, message, and timestamp.

On active-session load, provider history is hydrated exactly as it is today.
Persisted lifecycle events are then mapped to stable chat-message ids, merged
with that transcript by timestamp, and assigned deterministic display order.
The merge is idempotent, so live events already present in memory are not
duplicated during a reconnect or Codex tool-history backfill.

When an active session is closed, its transcript already contains lifecycle
messages. Closed-session persistence therefore writes them into the existing
closed transcript artifact. The close path explicitly hydrates lifecycle
events before writing as a recovery boundary for sessions closed after a server
restart.

Lifecycle events are append-only. Starting or successfully completing a later
turn changes the current runtime phase normally but never removes older stop
entries from the chat log.

## User Interface

The chat renderer adds a dedicated lifecycle-event row:

- prompt timeout, user stop, session close, workspace archive, and system stop
  use warning/neutral styling;
- provider failure and unexpected exit use error styling;
- the timestamp and exact reason copy remain visible in normal transcript
  chronology.

The event is not a transient toast and is not dependent on the runtime error
banner. Session-tab and Kanban runtime indicators continue to describe current
process state; the transcript describes what happened historically.

## Four-Hour Prompt Timeout

The standard timeout used by `SessionService.sendSessionMessage` changes from
`60 * 60 * 1000` to `4 * 60 * 60 * 1000`. Auto-iteration retains its separate
configurable timeout. Tool-specific timeouts, shutdown waits, queue waits, and
ratchet scheduling are unchanged.

The timeout remains a fixed upper bound rather than an inactivity timer. A turn
that reaches four hours is cancelled gracefully through the existing ACP
cancel path and records the durable timeout event before returning to idle.

## Error Handling

- Database persistence happens before live emission. A persistence failure is
  logged and the live UI may still receive a best-effort event, but the code
  never reports the event as durable.
- Lifecycle-event hydration failure does not block provider transcript loading;
  it logs the failure and leaves the session usable.
- Provider error text is normalized and bounded before persistence so an
  upstream payload cannot create an unbounded chat row.
- Unique dedupe keys make retrying an event write safe.
- A runtime-state transition to idle cannot remove a lifecycle transcript
  entry.

## Testing

Backend tests will prove:

- a prompt uses a 14,400,000 ms deadline;
- a prompt timeout records one `PROMPT_TIMEOUT` event with four-hour copy;
- provider failures, including a representative HTTP 529, record useful copy;
- manual stop and unexpected exit produce their distinct reasons;
- cancellation after manual stop does not create a duplicate turn event;
- duplicate dedupe keys produce one database row and one transcript message;
- lifecycle events survive store clearing and reappear after provider-history
  hydration;
- provider messages and lifecycle events merge in timestamp order;
- closing a restarted session includes lifecycle events in its saved transcript.

Frontend tests will prove:

- each lifecycle reason renders with its expected copy;
- timeout/manual/system reasons use warning or neutral styling;
- provider and unexpected-exit reasons use error styling;
- runtime transitions and reconnect snapshots do not remove rendered lifecycle
  entries.

Verification includes the focused Vitest files, Prisma schema checks and client
generation, dependency and ownership checks, typecheck, the full test suite,
Biome, and the production build.

## Out of Scope

- Changing auto-iteration's configurable prompt timeout.
- Resetting the four-hour deadline when tools or model output make progress.
- Adding user-configurable timeout settings.
- Retrofitting lifecycle events for sessions that ended before this schema
  exists.
