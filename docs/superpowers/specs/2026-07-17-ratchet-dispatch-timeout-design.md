# Ratchet Dispatch Timeout Design

## Problem

Ratchet workspace checks have a 90-second watchdog that aborts stalled GitHub reads and pre-dispatch work. A Ratchet fixer uses `start_empty_and_send`, which starts the ACP session and then awaits `sendSessionMessage`. That promise represents the entire agent turn, not merely prompt acceptance.

The dispatch is currently marked as committed only after `acquireAndDispatch` returns. Therefore, any valid agent turn that lasts longer than 90 seconds is treated as an uncommitted workspace check: the coordinator aborts it, the fixer eventually gets cleaned up, and Ratchet never persists the dispatch snapshot or its `REVIEW_PENDING` state. A model outage makes this more likely, but normal multi-minute fixer turns can trigger the same behavior.

## Desired Behavior

- Keep the 90-second watchdog for PR fetching, decision-making, session acquisition, and session startup.
- Once a fixer session has successfully started, treat the dispatch as a committed side effect.
- Do not abort or clean up a working fixer merely because its agent turn exceeds 90 seconds.
- Continue using the agent prompt timeout for genuinely stalled agent turns.
- Preserve cleanup when session startup fails or prompt delivery later fails.
- Preserve Ratchet's existing dispatch snapshot, retry, and workspace-state semantics.

## Design

`FixerSessionService` already exposes an `afterStart` callback, but the `start_empty_and_send` path invokes it after the awaited agent turn. Move that callback to immediately after `startOrRestartSession` succeeds and before `sendMessageSafely` begins.

Ratchet will provide an `afterStart` callback that invokes the coordinator's existing `commitSideEffects` function. The coordinator already disables its workspace watchdog after that marker, so no new timeout mechanism is required. `handleStartedFixerResult` may invoke the same marker again when it records the dispatch; the marker is idempotent.

The sequence becomes:

1. Fetch PR and review state under the 90-second watchdog.
2. Acquire and start the fixer session under the watchdog.
3. Invoke `afterStart`, marking side effects committed.
4. Send the prompt and await the agent turn under the session prompt timeout.
5. Persist the Ratchet dispatch record and workspace state.

The alternate `start_with_prompt` path retains its current behavior because session startup itself includes the prompt turn. Ratchet does not use that mode.

## Failure Handling

- If session acquisition or startup fails, `afterStart` is not called and the workspace watchdog remains effective.
- If prompt delivery fails after startup, the committed check finishes its existing cleanup path without being interrupted by the shorter workspace watchdog.
- Disabling Ratchet during dispatch continues to use the existing conditional persistence and unrecorded-session cleanup logic.
- No timeout value is increased; outages do not expand the time allowed for GitHub or database preflight work.

## Testing

Add a regression test around the real `start_empty_and_send` callback ordering:

- Block `sendSessionMessage` to represent a multi-minute agent turn.
- Assert `afterStart` runs after the session starts and before the blocked send resolves.
- Resolve the send and assert the normal `started` result is returned.

Add or extend a Ratchet service test to assert that the committed callback is wired through fixer acquisition. Existing coordinator tests continue to prove that uncommitted work times out and committed work may finish beyond the watchdog budget.

Run the focused Ratchet tests, TypeScript checks, and repository checks before publishing the PR.
