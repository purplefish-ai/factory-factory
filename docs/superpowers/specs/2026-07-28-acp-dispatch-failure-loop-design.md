# ACP Dispatch Failure Loop Design

## Problem

When an ACP prompt fails with a non-busy error, two independent recovery paths act on the same
message:

1. `SessionService` records an error runtime and schedules the zero-delay prompt-turn completion
   callback.
2. `ChatMessageHandlerService` removes the pessimistically committed transcript entry, marks the
   session idle, and puts the message back at the front of the queue.

The completion callback then sees an idle session with that queued message and dispatches it again.
If the ACP error persists, this repeats without a delay or attempt limit. Every cycle publishes
runtime transitions through `running`, `error`, and `idle`, plus message transitions through
`DISPATCHED` and queued snapshot state. Those conflicting updates cause the visible chat flicker.

## Considered Approaches

1. Fail the message once and restore it to the composer. This is selected because the client already
   recovers `FAILED` messages for manual retry, it produces one stable terminal state, and it does
   not strand an undispatchable message at the queue head.
2. Pause the queue after an error and add an explicit retry control. This preserves the queue entry,
   but requires a new paused-dispatch state and broader backend and UI work for behavior already
   covered by failed-message recovery.
3. Retry automatically with exponential backoff and an attempt cap. This can hide a brief provider
   outage, but still moves the message and runtime through several visible states and delays clear
   feedback for errors that will not recover.

## Design

Keep the existing successful dispatch and provider-busy paths unchanged. In particular, an ACP
response whose structured error contains `A turn is already in progress for this session` remains
queued and uses the existing exponential backoff because that response describes a known temporary
turn-coordination race.

For every other error caught after a message has been dequeued:

- Remove the pessimistically committed user transcript entry without publishing an intermediate
  snapshot.
- Do not mark the runtime idle. A prompt failure has already installed the ACP error runtime; an
  earlier configuration failure will be promoted to an error runtime by the dispatch handler.
- Do not put the message back in the queue.
- Publish one `FAILED` message-state transition with the normalized error text and the failed
  message content, including its source session ID.

The client handles `FAILED` and `REJECTED` identically, but a prompt can fail after the earlier
`DISPATCHED` transition has removed its queued recovery record. The reducer will therefore prefer
its queued or pending recovery content and fall back to the `FAILED` event's user-message payload.
It removes queue styling and the failed transcript entry, then restores the message text and
attachments to the composer only when the payload's source session still matches the selected
session. The runtime error banner remains stable instead of alternating with idle state. The user
can retry by sending the restored draft.

Permanent attachment validation remains `REJECTED`, since the backend refuses that input before an
ACP prompt begins. Stop-generation invalidation also remains unchanged: a dispatch invalidated by
an explicit stop is rolled back silently and must not surface a stale failure.

Workspace-notification delivery remains safe. A failed notification message is not marked
delivered, so its persisted notification row remains eligible for delivery when a later session
starts; the failing live queue entry no longer spins.

## Data Flow

1. The backend accepts and dequeues message `m1`.
2. It emits `DISPATCHED`, commits `m1` for refresh safety, and awaits the ACP prompt.
3. ACP rejects the prompt with `code -32603: Internal error`; the session runtime becomes `error`
   and schedules the normal completion callback.
4. The dispatch handler removes the temporary transcript entry and emits `FAILED` for `m1`, with
   its recovery content and source session ID, without requeueing it or returning the runtime to
   idle.
5. The completion callback finds no queued head and exits.
6. The client restores `m1` to the composer and displays one stable runtime error banner.

## Testing

Add a focused chat-dispatch regression test for a generic structured ACP internal error. It must
prove that the handler:

- attempts the prompt exactly once;
- rolls back the temporary transcript entry;
- does not mark the session idle or requeue the message; and
- emits one `FAILED` transition containing the normalized ACP error and recovery content.

Add a reducer regression that applies `ACCEPTED`, `DISPATCHED`, and then `FAILED`, proving the
terminal event restores `lastRejectedMessage` from its payload after the queued record is gone and
preserves the source session guard.

Retain the existing busy-turn regression test to prove that the special backoff/requeue behavior is
unchanged. Run the focused tests through a red-green cycle, then run the session test suite,
typecheck, repository checks, and build.
