# Background Jobs

Recurring backend work is declared to `jobRunner`
(`src/backend/services/job-runner.service.ts`), which owns the loop lifecycle
for the poll loops: the snapshot reconciliation safety net, the PR
sync/discovery poll, the periodic reconciliation cleanup, PR monitoring, the
periodic-task poll, GitHub agent source intake, and workspace metadata updates.
Each owning service or orchestrator registers its job and exposes thin
`start()`/`stop()` delegates. GitHub agent intake registers through
`createAgentRuntime()` in the agent-runtime orchestrator; its poll service owns
neither registration nor lifecycle methods. These delegates are the injection
seam `server.ts` and `server.upgrade.test.ts` use.

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
before each PR monitoring check — so a stop partway through does not walk the
whole list first. A service whose guard is also reachable outside a run
(`cleanupOrphans` at startup, admin-triggered ratchet checks) clears `runSignal`
in `start()`, or a restart would inherit the previous stop's aborted signal.

`waitForCurrentRun(name)` resolves on the run already in flight, not the next
one. Snapshot reconciliation has a narrower `waitForSeed()` barrier: the
`/snapshots` WebSocket handler waits only until database/runtime fields are in
the store and stale entries are removed. Authoritative metadata hydration is
part of that seed. The store sets `summaryVersion: 1` only after its
field-timestamp merge has accepted authoritative values for every required
summary field. Fields may be accepted across multiple updates; attempted values
in rejected timestamp groups and unhydrated defaults do not count. Git stats
continue streaming while the job remains in flight, so `stop()` still waits for
every Git task to settle.

There is deliberately no "run this job now" API. The two loops with a
cancellable sleep only ever cancelled it from their own `stop()`, so
interruptibility is a shutdown concern rather than a scheduling feature.
`stop()` waits unbounded for an in-flight run, exactly as every loop did before
— bounding it would change shutdown to abandon work mid-flight.

## Timer dispatch ownership

The `agent-source-poll` job runs immediately, then waits 60 seconds after each
cycle. It reads at most ten issue-event pages per repository per cycle, shared
between capture and verification. Its GitHub port uses the existing CLI budget
and cancellation signal. Shutdown stops and drains this intake before stopping
provider sessions or disconnecting the database. This job does not evaluate
events, activate saved triggers, or launch workspaces.

The existing `periodic-task-poll` remains the only periodic-task scheduler.
Eligibility, overlap checks, atomic execution reservation and schedule
advancement belong to the periodic capsule. After reservation, it awaits a
`timer_due` event through an injected dispatch port. Composition connects that
port to the shared background-action dispatcher's `new_workspace` arm and
existing PERIODIC_TASK workspace launcher. The capsule then links the workspace
or settles a launch failure, and continues its existing completion monitoring.

Stopping the poll prevents later task admission and drains an already admitted
launch through its workspace link or failure settlement. It does not cancel or
detach the dispatch promise. An unlinked reservation remains subject to the
15-minute timeout; restarting the poll does not replay its launch.

## Out of scope by design

The `fileLock`, `terminal`, and `rateLimiter` cleanup timers. They are
process-local memory eviction with no database or network work and no
shutdown-ordering hazard.
