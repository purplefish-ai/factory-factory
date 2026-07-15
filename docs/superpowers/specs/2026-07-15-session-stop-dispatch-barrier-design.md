# Session Stop Dispatch Barrier Design

## Problem

`SessionLifecycleService.stopSession()` clears prompt-turn completion timers before awaiting session loading and runtime shutdown, but an active ACP prompt can settle during either await. `SessionService.executeAcpMessage()` then schedules a new zero-delay completion callback. The completion handler calls queued-message dispatch, which can dequeue and send the next message while the stop is still cleaning up because dispatch checks client/workspace state but not the lifecycle stop state.

The runtime manager's `isStopInProgress()` state cannot be the sole barrier because it begins only inside `stopClient()`, after `stopSession()` has already awaited session loading. The mutable runtime snapshot cannot be the sole barrier either because prompt settlement writes an idle/alive snapshot while shutdown is pending.

## Considered Approaches

1. Add a lifecycle-owned stop barrier and consult it from prompt completion and queued dispatch. This is the recommended approach because the barrier begins synchronously at the `stopSession()` entry point, remains stable even when runtime snapshots change, and protects callbacks that were already running when stop began.
2. Clear queued work before awaiting `stopClient()`. This narrows the reported race but does not prevent messages queued during shutdown or completion callbacks already past the timer-clear step from dispatching.
3. Guard only with `AcpRuntimeManager.isStopInProgress()`. This protects the runtime shutdown window but leaves the earlier session-loading window unprotected and makes the queue layer depend on a provider-runtime implementation detail.

## Design

`SessionLifecycleService` will own a per-session `stoppingSessions` set. `stopSession()` will reserve the session in that set before its first await and release it only after all stop cleanup completes. Concurrent stop requests will return without disturbing the first stop's barrier. Immediately after reserving the barrier, stop will clear the queue that existed when the user requested shutdown. A public `isSessionStopping(sessionId)` query will combine this lifecycle reservation with the runtime manager's stop state, preserving protection for runtime-managed shutdown paths.

`SessionService` will expose that query as the session capsule's lifecycle API. `executeAcpMessage()` will not schedule prompt-turn completion when the session is stopping. `ChatMessageHandlerService.tryDispatchNextMessage()` will check the same query before reserving dispatch work and again immediately before dequeueing. The second check closes the window in which stop begins while dispatch is awaiting the workspace gate or client resolution.

The existing stop handler retries dispatch after `stopSession()` finishes. Moving queue cleanup to stop entry means work present at the stop request is discarded, while messages newly queued during shutdown remain behind the barrier and are eligible for that post-stop retry. No database, protocol, UI, or Prisma changes are required.

## Error Handling and Edge Cases

- A prompt that succeeds or fails while stop is pending must not schedule queued dispatch.
- A completion callback or other dispatch attempt that starts before stop but reaches dequeue afterward must leave the message queued for stop cleanup.
- A concurrent duplicate stop must neither clear the first stop's barrier early nor discard messages newly queued during the first stop.
- Stop cleanup failures must still release the lifecycle barrier after the existing cleanup path completes or throws, so a later explicit restart is not permanently blocked.
- Normal prompt completion and normal queued dispatch remain unchanged when no stop is active.
- The stop handler can dispatch work newly queued during shutdown only after the stop barrier has been released and stop cleanup has finished.

## Testing

- Add a session-service regression test that holds `stopClient()` pending, settles an active prompt, flushes the completion timer, and proves the queued-dispatch completion handler is not invoked.
- Add a lifecycle regression assertion that the pre-stop queue is cleared before the pending runtime stop resolves.
- Add chat-dispatch tests for a stop already active at dispatch entry and for a stop beginning while asynchronous dispatch gating is pending; both must avoid dequeue and send.
- Run the focused lifecycle/chat test files through the red-green cycle, then run typecheck, formatting/lint fixes, the full Vitest suite, and the production build.
