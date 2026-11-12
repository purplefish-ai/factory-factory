# Background Jobs

The `application-update-idle` job checks pending update readiness once per
second while the application is alive. It performs no registry or installation
work; the cached release service owns registry checks and the CLI supervisor
owns installation. Readiness closes agent admission synchronously with the final
idle check, then sends `update-ready` to the CLI supervisor. Once readiness is
sent, cancelling a waiting update retains the admission fence until the
supervisor acknowledges idle; preparation may already have begun. Application
shutdown stops this job before draining agent runtimes.

Recurring backend work is declared to `jobRunner`
(`src/backend/services/job-runner.service.ts`), which owns the loop lifecycle
for the poll loops: the snapshot reconciliation safety net, the PR
sync/discovery poll, the periodic reconciliation cleanup, archived workspace
data retention, PR monitoring, PR event ledger retention, the periodic-task
poll, GitHub agent source intake, event evaluation/admission, and workspace
metadata updates. Each owning service or orchestrator registers its job and
exposes thin `start()`/`stop()` delegates. GitHub agent intake registers through
`createAgentRuntime()` in the agent-runtime orchestrator; its poll service owns
neither registration nor lifecycle methods. These delegates are the injection
seam `server.ts` and `server.upgrade.test.ts` use.

Both PR pollers live in `src/backend/orchestration/pull-requests/`:
`scheduler.service.ts` owns `pr-poll` (PR sync and discovery), and
`ratchet.service.ts` owns `pr-event-poll` (PR monitoring) and
`pr-event-retention`. The composition root builds one `RatchetService` per
application graph through `createRatchetService()`, which supplies its
observation, delivery-wake, cutover and monitoring-change operations. Shutdown
labels these drains `pr-poll` and `pr-event-poll` after their jobs, and their
cadences are `SERVICE_INTERVAL_MS.prPoll` and `prEventPoll`.

## Pacing

Jobs are paced **sequentially**: the delay runs from the end of one run to the
start of the next, so a job can never overlap itself and there is no
skip-if-in-flight guard to get wrong. This replaced three `setInterval` loops,
whose runs used to land on a wall-clock boundary; a run of `d` ms now pushes the
next start to `interval + d`.

Two per-job options carry behaviour the loops depended on:

- `runImmediately` — `pr-event-poll`, periodic tasks and snapshot reconciliation
  poll once on start; `pr-poll` and reconciliation cleanup wait out the first
  interval.
- `computeDelay` — consulted after every run, which is how `pr-event-poll`
  stretches its interval under GitHub rate limiting.

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

Teardown is one ordered plan, `createShutdownPlan` in
`src/backend/application-shutdown.ts`. Server shutdown and `disposeApplication`
(used when no server took ownership of the graph) both run it, so a component
stopped on one path is stopped on the other; the server adds only its transport
and timer work through hooks at fixed points.

The plan immediately calls `stop()` for application update idle, reconciliation
cleanup, `pr-poll`, snapshot reconciliation, `pr-event-poll` with PR event
retention, and periodic tasks. It also fences launcher-option discovery and both
model catalog services. Their in-flight work drains concurrently with
session/process teardown and with each other: shutdown waits for the slowest
drain, not the sum. Discovery aborts its disposable provider children and bounds
its drain at seven seconds; physical lifetimes remain charged independently of
caller timeouts.

Agent runtime and workspace metadata jobs stop at their own ordered steps: agent
runtime first, workspace metadata before transports and sessions close. Codex
account teardown waits for launcher-option and Codex model-catalog drains, which
can still read account context. Claude catalog discovery has no Codex account
dependency and drains at the final backstop instead. Recurring job drains are
awaited after sessions, Codex logins, run scripts and the rate limiter have
stopped, and all drains before the database disconnects. The event collector
stops after `pr-poll` drains; the Git state service stops after snapshot
reconciliation drains. `jobRunner.stopAll()` then runs as a backstop, so a
registered job without an owner in the plan is still stopped before the
disconnect. A failed job `stop()` is logged with its job name and does not block
the other drains or the disconnect. A failed step is logged with its step name;
the later steps still run, and shutdown then rejects. Startup re-checks for
cleanup after each await before starting more jobs, since a start issued after
its stop would revive the job; a startup interrupted that way rejects once
cleanup finishes.

There is deliberately no "run this job now" API. The two loops with a
cancellable sleep only ever cancelled it from their own `stop()`, so
interruptibility is a shutdown concern rather than a scheduling feature. For
recurring poll loops, `stop()` waits unbounded for an in-flight run — bounding
it would change shutdown to abandon work mid-flight.

### Fatal backend errors

The standalone backend claims one shutdown attempt before logging a fatal error.
Further uncaught exceptions and unhandled rejections during cleanup do not write
more fatal records or restart cleanup. Its terminal error is appended
synchronously to `logs/server.log`, without a console echo, so an immediate
failure exit retains the original cause when the filesystem is available. If the
file append fails, a synchronous fallback to file descriptor 2 attempts to
preserve the same record. Test processes without a log file (see
[Verification](../../CONTRIBUTING.md#verification)) use the same fallback. Short
writes continue from the next byte; an error or zero progress stops the fallback
without recursive logging. Ordinary console logging disables a stdout/stderr
sink after a write failure; sink failures are never logged back through that
sink.

Fatal cleanup has a 30-second deadline, after which the standalone backend exits
with status 1. This bounds failed-process cleanup without changing normal job
`stop()` drains. Electron's separate backend stop/kill budget still applies to
the desktop utility process; this deadline does not extend it.

## Archived workspace data

The `archived-workspace-blob-retention` job is registered beside
`reconciliation-cleanup` and starts and stops with it, so the shutdown plan's
reconciliation step drains both. It waits ten minutes, then releases ARCHIVED
workspaces that still carry `initialAttachments` or more setup log than they
keep (see [workspace state](workspace-state.md)). A run handles at most 50
batches of 10 rows, in id order. Each batch is a short id SELECT followed by a
short UPDATE of those ids that re-checks ARCHIVED; the run yields between
batches and stops before the next one on abort. A backlog of about 1,400 rows
drains in three runs, about half an hour after startup. Once nothing is left, a
run is one read-only query over the archived rows that selects nothing. Archive
releases new workspaces itself, so the job only finds rows archived before that
existed, missed releases, and imported backups.

## Timer dispatch ownership

The `agent-source-poll` job runs immediately, then waits 60 seconds after each
cycle. It reads at most ten issue-event pages per repository per cycle, shared
between capture and verification. Its GitHub port uses the existing CLI budget
and cancellation signal. Shutdown stops and drains this intake before stopping
provider sessions or disconnecting the database. After resolving its repository,
each target with a valid, non-recovery cursor advances one bounded
source-checkpoint backfill, authority-validation, or compaction transaction;
this uses retained database proof and makes no provider requests. After each
cycle the same job completes pending activations: a STARTING trigger becomes
ACTIVE once its prepared baseline resolves, retries a baseline that was never
recorded, and returns to PAUSED with a reason on source failure, recovery or
after 30 minutes (`activationExpiryMs`). There is no separate activation job.
This job does not evaluate events or launch workspaces.

The `agent-event-evaluation` job runs immediately, then waits five seconds after
completion. It evaluates at most 100 durable event/trigger candidates per cycle,
rotating past deferred decisions. GitHub matching supports `labeled` and
`reopened` and fails closed when a trigger also lists an unsupported action. A
`labeled` event matches its added label. A `reopened` event matches when the
issue carried a configured label at capture, or always when no labels are
configured. A GitHub run input starts with a source item naming the repository,
issue number and link, and the triggering action (with the JSON-quoted added
label for `labeled`), followed by the issue title and body. Semantic and actor
filters fail closed; SCHEDULE stays with PeriodicTask. STARTING generations are
never candidates; the source poll job completes, cancels or expires them. Only
configured triggers (`isConfigured = true`) receive new decisions; an
unresolved decision left by a removed trigger is still settled. Terminal
decisions are not replayed under new revisions or generations.

Queue maintenance rotates through bounded batches even when all active slots are
occupied. Claims choose FIFO heads of unsaturated definitions and serialize
revision, generation, activation, readiness and capacity checks with pause/edit.
A transient source error defers waiting work; disabled connections and
continuity recovery failures cancel it. Malformed non-null source health fails
closed as invalid stored data. Deferred claims report CAPACITY for confirmed
capacity limits; source/retry waits report WAITING. Maintenance advances its
cursor only after the database transaction commits. Expiry and retry gates use
time captured after acquiring the ledger write lock. Claims committed before
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

The application installs a durable event launch consumer. A committed claim is
registered before asynchronous work begins; the evaluation job returns after
that handoff, allowing up to the configured global capacity to progress
independently. The separate `agent-launch-maintenance` job uses the five-second
cadence to renew sixty-second leases and recover bounded pages even while
evaluation is stalled. Shutdown closes admission, drains committed handoffs,
aborts and joins owned setup, and interrupts initial provider work before
session and database teardown. Session teardown retains the final observation
drain, and the shared shutdown plan drains sessions before cancelling Codex
logins.

That same launch-maintenance owner observes initial outcomes and tracked work,
retaining leases after the initial response until settlement. Expired
observation ownership can be adopted without a send or retry-budget charge;
local capacity is checked again after the adoption await. A revoked launch that
later finishes releases only its own local owner, never a replacement. Its
bounded pages report malformed rows separately and advance by the last inspected
row, so bad data cannot hide later valid work. Missing live work coverage
retains capacity after restart. Already-started failed dispositions and
monitoring operations share the existing evidence deadline; expiry closes their
guard so late continuations cannot start another write. Physical setup/stop
ownership still drains through its original owner.

Provisioning retries retain RUNNING capacity, frozen snapshots, identities and
account; they never return to the authoring-sensitive QUEUED state. Retry-After
extends the remaining shared retry delay. Only typed transient failures retry.
The original fifteen-minute setup deadline is retained across safe retries.
Unknown cleanup keeps capacity and forbids retry. Saved agents are enabled
through the trusted-local `automation.enable` procedure; the UI control and the
positive child-cleanup product boundary are separate work.

The evaluation job also owns bounded ledger retention before evaluation: one
rotating page each of expired evaluations, event payloads and event identities.
An explicitly configured terminal run context policy adds one bounded page under
the same owner, with independent cursor/metrics; the default retains
indefinitely. Its live shutdown signal is checked after awaited dependency
reads, before mutations and at the final transaction boundary. Cursors publish
only after commit, including progress past retained candidates; aborted batches
roll back. A retention failure rolls back its current batch and logs a sanitized
reason; evaluation and claims continue unless the live job signal is aborted.
There is no additional agent-ledger retention job or timer. See
[integrations](./integrations.md) for the 30/90-day boundaries and retained
source-proof/history lifetimes.

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
