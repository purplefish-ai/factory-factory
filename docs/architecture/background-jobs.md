# Background Jobs

Recurring backend work is declared to `jobRunner`
(`src/backend/services/job-runner.service.ts`), which owns the loop lifecycle
for all five poll loops: the snapshot reconciliation safety net, the PR
sync/discovery poll, the periodic reconciliation cleanup, the ratchet, and the
periodic-task poll. Each service registers its job in its constructor and keeps
a thin `start()`/`stop()` that delegates — those delegators are the injection
seam `server.ts` and `server.upgrade.test.ts` use, not leftovers.

## Pacing

Jobs are paced **sequentially**: the delay runs from the end of one run to the
start of the next, so a job can never overlap itself and there is no
skip-if-in-flight guard to get wrong. This replaced three `setInterval` loops,
whose runs used to land on a wall-clock boundary; a run of `d` ms now pushes the
next start to `interval + d`.

Two per-job options carry behaviour the loops depended on:

- `runImmediately` — the ratchet, periodic tasks and snapshot reconciliation
  poll once on start; PR sync and reconciliation cleanup wait out the first
  interval.
- `computeDelay` — consulted after every run, which is how the ratchet stretches
  its interval under GitHub rate limiting.

Every cadence lives in `SERVICE_INTERVAL_MS`
(`src/backend/services/constants.ts`). Snapshot reconciliation's used to be a
local constant in its own orchestrator, which is how it escaped notice.

## Shutdown

`run` receives an `AbortSignal` that aborts on stop. Services expose it as a
private `isShuttingDown` getter, because the flag it replaced was read at
intermediate points inside long batches — between workspaces in the PR sync,
before each ratchet check — so a stop partway through does not walk the whole
list first. A service whose guard is also reachable outside a run
(`cleanupOrphans` at startup, admin-triggered ratchet checks) clears `runSignal`
in `start()`, or a restart would inherit the previous stop's aborted signal.

`waitForCurrentRun(name)` resolves on the run already in flight, not the next
one; the `/snapshots` WebSocket handler uses it to hold the first
`snapshot_full` until the startup reconciliation has seeded the store.

There is deliberately no "run this job now" API. The two loops with a
cancellable sleep only ever cancelled it from their own `stop()`, so
interruptibility is a shutdown concern rather than a scheduling feature.
`stop()` waits unbounded for an in-flight run, exactly as every loop did before
— bounding it would change shutdown to abandon work mid-flight.

## Out of scope by design

The `fileLock`, `terminal`, `rateLimiter` and conversation-rename cleanup
timers. They are process-local memory eviction with no database or network work
and no shutdown-ordering hazard.
