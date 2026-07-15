# Ratchet Workspace Check Cancellation Design

## Goal

Prevent a timed-out ratchet workspace check from continuing to dispatch fixers or persist stale state, and limit each ratchet poll to at most three concurrently executing workspace checks.

## Root Cause

`RatchetWorkspaceCheckCoordinator` currently races an in-flight check against a timer. When the timer wins, it rejects the caller and removes the in-flight map entry, but it cannot stop the underlying promise. A later poll can therefore start a second check for the same workspace while the first check continues through GitHub reads, fixer dispatch, and state persistence.

`RatchetService.checkAllWorkspaces` also maps every workspace directly into `Promise.all`. Each workspace can start two GitHub reads, so a large poll creates a burst before the GitHub CLI's separate process-level limiter applies backpressure.

## Design

### Coordinator-owned cancellation

Each new coordinator entry will contain both the shared check promise and an `AbortController`. The runner signature will become `(signal: AbortSignal) => Promise<WorkspaceRatchetResult>`. Concurrent callers for the same workspace will continue to share the same entry.

When a caller's workspace timeout expires, the coordinator will abort the shared controller with the existing `Workspace check timed out after <n>ms` error and remove that exact entry from the map. The caller will receive that timeout error. The runner must observe the signal and terminate; its `finally` cleanup remains identity-checked so an old check cannot delete a successor's entry.

### Abort propagation and side-effect barriers

The signal will flow through `runWorkspaceCheckSafely`, `processWorkspace`, `fetchPRState`, the ratchet GitHub bridge, and the two GitHub CLI reads used by ratchet (`getPRFullDetails` and `getReviewComments`). Ratchet code will call `signal.throwIfAborted()` before starting asynchronous work and after awaited operations, with mandatory checks immediately before fixer dispatch and persistence.

The PR-state helper will always release its fetch-registry claim on failure. If the signal is aborted, it will rethrow the signal's reason instead of converting cancellation into a normal `null` fetch result or rate-limit backoff event. `processWorkspace` will likewise rethrow cancellation so the coordinator's timeout remains the reported result rather than becoming an internal ratchet error.

GitHub CLI execution will accept an optional signal and pass it to `execFile`. Calls with a signal will not use the existing argument-based singleflight map: a ratchet timeout must not abort an identical request shared by a non-ratchet caller, and a second caller must not inherit a process controlled only by the first caller's signal. Calls without a signal retain existing singleflight behavior and all calls retain the global GitHub process limiter.

### Workspace concurrency

`checkAllWorkspaces` will use a ratchet-local `p-limit(3)` limiter around `runWorkspaceCheckSafely`. Result ordering and aggregate counts remain unchanged because the limited promises are still gathered with `Promise.all`. Direct `checkWorkspaceById` calls retain same-workspace coordinator deduplication and do not enter the batch limiter.

## Error Handling

- A timeout remains an `ERROR` action whose message contains the configured workspace timeout.
- An aborted GitHub request releases the workspace fetch claim and does not trigger rate-limit backoff handling.
- A non-abort GitHub failure keeps the current behavior: release the claim, feed the error to rate-limit backoff, and return a failed PR fetch.
- Abort checks before dispatch and persistence prevent completed-but-late upstream awaits from producing side effects after timeout.

## Testing

Tests will establish these behaviors before implementation:

1. The coordinator passes a signal to its runner and aborts it on timeout while preserving same-workspace deduplication.
2. A timed-out service check cannot continue into a later side effect after its blocked await is released.
3. The PR-state helper forwards the signal to both GitHub reads, releases the fetch claim on abort, rethrows the timeout reason, and skips rate-limit backoff.
4. The ratchet GitHub bridge forwards the signal to the GitHub CLI service.
5. The GitHub CLI passes the signal to the child process and does not singleflight signal-bound calls.
6. A ratchet batch never runs more than three workspace checks concurrently and still returns all results.

Targeted ratchet, orchestration bridge, and GitHub CLI tests will run alongside type checking and the repository guardrails.

## Non-goals

- Cancelling arbitrary database or session-service operations internally.
- Changing the 90-second timeout or the GitHub CLI's global concurrency limit.
- Changing ratchet decision logic, fixer deduplication, poll cadence, or result aggregation.
