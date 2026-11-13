# Run-Script Execution Ownership Design

Status: reviewed model with the initial pilot implemented; broader settlement
and durable cross-process fencing remain deferred.

## Intent

Make one run-script execution understandable without reconstructing its lifetime
from workspace-keyed maps, database status and asynchronous callbacks. Use the
run-script subsystem as a pilot for later session-lifecycle work. Success means
explicit ownership and transitions, with fewer opportunities for old work to
affect a replacement. Class count and line count are not goals.

The investigation below models the original implementation and proposes a
target. The pilot results section records reproduced races and the implemented
subset. The frontend testing spike remains separate.

## Approaches

The conversation selected domain ownership and explicit state machines over
mechanically splitting methods into helper classes. A wholesale replacement of
the existing database state machine would discard useful concurrency controls.

The proposed design adds one execution owner, preserves the existing persisted
status machine and workspace writer, and keeps workspace-lived output outside
the execution. Stateless decisions remain functions. Exact method names and
internal file organization are left to the implementer.

## Ownership before the pilot

- `RunScriptService` owns current main processes, postRun processes, a weak set
  of main processes being stopped, output channels and shutdown bookkeeping.
- `RunScriptStateMachineService` already validates persisted transitions and
  uses status-based compare-and-swap. It calls the workspace service; the
  workspace capsule retains Prisma writer ownership.
- `RunScriptProxyService` owns tunnels and authentication proxies, addressed by
  workspace ID. It returns a URL, rather than an execution-owned lease.
- Process helpers spawn commands, decode streams, send signals and await bounded
  exit observations. They are implementation mechanisms, not another domain
  layer.
- Commands are reconciled from factory configuration. Start uses reconciled
  run/postRun commands; stop refreshes the cleanup command and falls back to its
  cached value. Freezing cleanup configuration at start would change this.

Source: `src/backend/services/run-script/service/`, the workspace run-script
service/accessor, and `src/backend/services/run-script/AGENTS.md`.

## Three distinct concepts

### Workspace run-script slot

A workspace has a current execution, persisted status and output channels. The
slot survives individual runs. Its current-execution registry can remain a
`Map<workspaceId, RunScriptExecution>`; the map is an index, not the lifecycle.
The service coordinates admission, configuration, workspace persistence,
recovery, output APIs and application shutdown.

### RunScriptExecution

One admitted attempt has an identity before a process exists. A child handle
identifies its main process once spawned; PID alone is not execution identity.
The execution owns that handle, its postRun child, stop intent, exit evidence
and asynchronous operations associated with that attempt. An owned tunnel lease
is a target boundary, requiring a separate proxy API change.

Operations express behavior: attach a spawned process, request stop, observe an
exit, finish startup, and settle owned resources. They do not expose mutable
maps or arbitrary state setters. Callbacks retain their execution identity.
Joining repeated stop/settlement requests is a target improvement, not a
guarantee to add silently during extraction.

A current-execution index is insufficient to retain predecessors still doing
cleanup. Initially preserve existing discoverability and release behavior:
callbacks may hold an old execution, but shutdown does not gain a new inventory
of retired executions. A later retention guarantee must keep those owners
discoverable separately until the chosen settlement policy releases them.

### Workspace output channels

Subscriptions and retained output have workspace lifetime. A dev-logs socket
must survive stop/start. Starting a run resets the retained buffers according to
existing behavior without deleting subscribers. Archive/delete evicts them. Do
not put these channels inside a disposable execution object. Keep the existing
`RunScriptOutputBuffer` abstraction.

## Explicit state model

### Persisted workspace status: keep the existing machine

The implementation's transition table allows:

- IDLE -> STARTING.
- STARTING -> RUNNING, COMPLETED, FAILED or STOPPING.
- RUNNING -> COMPLETED, FAILED or STOPPING.
- STOPPING -> IDLE.
- COMPLETED or FAILED -> IDLE or STARTING.

Startup recovery resets stale STARTING/STOPPING rows outside normal transitions.
RUNNING rows retain PID evidence for orphan verification. Preserve this recovery
path; do not manufacture a local child handle from a PID.

### Local execution: physical lifetime and settlement are separate

Represent the main-process observation as an explicit union, conceptually:

- Preparing: admitted attempt; no owned main process yet.
- Live: owned child; no exit or spawn-failure evidence observed. This does not
  prove operating-system liveness.
- Ended: retained exit or spawn-failure evidence.

Stop intent is independent of this observation. A live process can be stopping;
a successful signal request is not proof that it exited. The existing exit
helper has a bounded wait and can also resolve on error. Preserve those
semantics initially; do not silently promise confirmed termination. Record an
unconfirmed stop result alongside the child observation rather than pretending
the process ended or discarding its identity.

Settlement records the remaining obligations: durable status reconciliation,
postRun termination and tunnel release. A rejected database write must not erase
the evidence needed to retry. An ended main process can still have unsettled
work. The target is to represent failed obligations explicitly and retry only
under a defined policy. Initially preserve today's retry and best-effort release
policies, including logged process-tree errors and synchronous cleanup's final
map clearing. Graceful cleanup retains cancelled pending admission identity
until the caller can reconcile its late write; it clears only its captured
current owners. Recording uncertainty must not accidentally introduce unbounded
retention, additional retries or stricter stop results.

These dimensions should not become a Cartesian-product enum. Use a small union
for process evidence, explicit stop-operation ownership and explicit settlement
obligations. Full retention until owned work settles is a later guarantee; the
initial extraction preserves existing release behavior.

## Invariants and effects

1. Main-process events belong to one execution. Recheck ownership after awaits
   before affecting workspace-level state or resources of a replacement.
2. Register child handlers before asynchronous RUNNING persistence. A fast exit
   may validly persist COMPLETED/FAILED directly from STARTING.
3. postRun is an auxiliary process launched after RUNNING/tunnel setup, not a
   command launched when the main process exits. Do not launch it after stop
   intent or main-process exit; stop/exit cleanup must include its ownership.
4. A tunnel that finishes starting after its owner stops must release its own
   resources. Workspace ID alone cannot express which execution may release it.
5. Exit persistence currently retries at most three times. Exhaustion preserves
   the tracked child as evidence. Keep that contract during extraction.
6. Natural completion and explicit stop have different durable outcomes. A
   stopping exit completes STOPPING -> IDLE; normal exit chooses COMPLETED or
   FAILED. The user cleanup command runs on explicit active stop, before
   main-process termination, not on every natural exit.
7. Shared output subscriptions outlive executions. Stream closure can follow
   process exit; do not detach listeners merely because a stop was requested.
8. Graceful shutdown and synchronous exit cleanup remain distinct. The latter
   cannot await user cleanup scripts, persistence or process-tree observation.

Pure functions may decide an exit's intended durable outcome or whether new
auxiliary work is allowed. The execution owns process effects; the existing
status machine owns durable transitions. Collaborators receive narrow ports, not
a reference to the entire coordinating service.

## What this investigation exposed

The persisted status is not a complete resource-lifetime model. Exit handling
can publish a terminal status before postRun/tunnel cleanup finishes. Stop and
exit handlers may both complete STOPPING. Database status therefore cannot be
used as proof that every execution-owned effect has settled.

There is an ownership gap before spawn: `startRunScript` awaits configuration,
status admission and possibly port allocation before installing a child in the
map. Several later checks use child identity, which cannot cover that interval.
Status-only CAS also does not identify an attempt after a status cycles back to
the same value. A local execution token can fence local continuations; it does
not by itself fence a durable write already in flight or another backend
process. Those require serialized admission/settlement or a durable attempt
token. Do not claim a local class alone solves either problem.

The tunnel API is another gap: cleanup is workspace-scoped even when the caller
has checked child ownership. An ownership-aware lease or serialization is needed
to make resource replacement safe across awaits.

These are structural findings and targeted regression candidates, not confirmed
bugs. Reproduce the interleavings before choosing behavior or schema changes.

## Tests and incremental delivery

1. Preserve and classify existing tests by admission, fast exit, stop,
   persistence failure, replacement, postRun/tunnel lifetime, output and
   shutdown. Split suites without weakening assertions or creating a giant
   shared fixture. The existing process-lifecycle suite already demonstrates
   public start/stop operations and controllable child events.
2. Add deterministic characterization experiments for stop during port
   allocation, replacement during exit persistence, late tunnel completion, and
   exit during a pending user cleanup command. Record current outcomes
   separately from proposed guarantees. Use deferred completions, not sleeps.
3. Extract the execution owner while retaining service APIs, persisted enums,
   cleanup command lookup, recovery and timeout/retry behavior. Keep identity
   and state private. Move regressions from private-map manipulation to public
   operations or explicit execution methods as each behavior moves.
4. Address reproduced ownership gaps in separate changes. Prefer scoped resource
   ownership and local serialization if sufficient. Add durable identity only if
   the demonstrated interleaving requires it. Explicitly decide whether new
   admission waits for old settlement; that is a behavior decision, not a
   consequence to hide in a structural extraction.
5. Lower file-length baselines after genuine reductions. Judge the pilot by
   tracing start/stop with fewer files and fewer independently mutable facts,
   not by a target number of classes.

Implementation validation follows CONTRIBUTING.md: focused and full Vitest
tests, typecheck and repository checks, with unrelated formatter changes
excluded. Proxy ownership changes also require its focused suite. No frontend
coverage gate or browser-test expansion is part of this pilot.

## Decisions left to the implementation plan

Exact union/method names, fixture organization and extraction order are routine
implementation decisions. Schema changes, changed admission timing, stronger
termination guarantees and changed cleanup retry behavior require evidence from
the characterization experiments and an explicit design update. The initial
extraction must not depend on resolving all those follow-up questions.

## Pilot results

Deterministic public-API tests reproduced stopped startup after port allocation,
old admission overwriting a replacement, auxiliary startup during user cleanup,
and old stop reconciliation after replacement. Scoped proxy tests reproduced
late publication after stop, replacement and shutdown. These are fixed with
execution identity and resource-scoped tunnel leases, without a schema change.

The service keeps two indexes of the same domain object: pending admissions and
current executions. Pending admission cannot replace a current process until the
persisted STARTING operation returns. Stop can revoke that pending owner, even
if STARTING committed before its caller resumes. Graceful cleanup retains
cancelled pending identity until the caller reconciles a late write and exits;
it does not promise to drain every possible pre-admission operation.

Exit handling releases an execution's own postRun/tunnel resources even if its
durable transition admitted a replacement. It does not erase the replacement's
index entry. The original 101 service regression tests are preserved in seven
smaller suites, with direct execution operations replacing private-map setup
where practical. Workspace output tests use real child stream events.

The pilot does not add durable attempt IDs, a retained predecessor inventory,
stop coalescing, stronger process termination guarantees or additional cleanup
retries. Database-status recovery and workspace writer ownership remain intact.

### Review follow-up

Startup checks live/current eligibility before publishing RUNNING; retained exit
evidence is not permission to write a PID into a replacement admission. Natural
fast exits still return successful startup without a stale transition. Forced
synchronous cleanup treats `killed` as a signal request, not an exit: children
without exit evidence receive SIGKILL even after SIGTERM was sent. These changes
do not claim that a signal confirms physical termination.
