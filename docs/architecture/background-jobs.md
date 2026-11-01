# Background Jobs

Recurring backend work is declared to `jobRunner`
(`src/backend/services/job-runner.service.ts`), which owns the loop lifecycle
for the poll loops: the snapshot reconciliation safety net, the PR
sync/discovery poll, the periodic reconciliation cleanup, PR monitoring, the
periodic-task poll, GitHub agent source intake, event evaluation/admission, and
workspace metadata updates. Each owning service or orchestrator registers its
job and exposes thin `start()`/`stop()` delegates. GitHub agent intake registers
through `createAgentRuntime()` in the agent-runtime orchestrator; its poll
service owns neither registration nor lifecycle methods. These delegates are the
injection seam `server.ts` and `server.upgrade.test.ts` use.

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

The `agent-event-evaluation` job runs immediately, then waits five seconds after
completion. It evaluates at most 100 durable event/trigger candidates per cycle,
rotating past deferred decisions. GitHub matching supports only `labeled` and
matches the added label. Semantic and actor filters fail closed; SCHEDULE stays
with PeriodicTask. STARTING generations remain held until activation owns their
completion, cancellation, or expiry. Terminal decisions are not replayed under
new revisions or generations.

Queue maintenance rotates through bounded batches even when all active slots are
occupied. Claims choose FIFO heads of unsaturated definitions and serialize
revision, generation, activation, readiness and capacity checks with pause/edit.
A transient source error defers waiting work; disabled connections and
continuity recovery failures cancel it. Malformed non-null source health fails
closed as invalid stored data. Deferred claims report CAPACITY for confirmed
capacity limits; source/retry waits report WAITING. Maintenance advances its
cursor only after the database transaction commits. Claims committed before
pause are in-flight work. The defaults remain one active run per definition,
four globally, 100 waiting per definition and a 24-hour waiting expiry. Overflow
is terminal for that whole definition/event, including overlapping triggers
evaluated later.

Evaluation retries persist their attempt count and next time: three retries at
30 seconds, two minutes and ten minutes, extended by Retry-After when needed.
Permanent configuration failures do not retry. The winning evaluation's used
retries transfer into AgentRun.attemptCount; the initial launch claim increments
it to the successful evaluation attempt number. Provisioning must continue that
same budget rather than start another four attempts. Non-dispatching decisions
retain an explicitly marked configuration snapshot that admission cannot use.

The runtime has an optional injected launch-claim consumer. Until a launcher is
wired, evaluation/admission and queue maintenance run but no run is claimed. A
wired consumer owns settlement of every committed claim and shutdown drains that
consumer before runtime dependencies stop.

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
