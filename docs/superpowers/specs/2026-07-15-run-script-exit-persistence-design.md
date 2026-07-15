# Run-Script Exit Persistence Design

## Problem

The run-script exit handler removes the tracked child process and output listeners before it
persists the terminal state. It then catches every transition error as if it were an expected
compare-and-swap race. A transient database failure can therefore leave the workspace persisted
as `STARTING`, `RUNNING`, or `STOPPING` after the process has exited, with no in-memory evidence
left to distinguish the real exit result.

## Considered approaches

1. **Retry and classify in the run-script exit path (chosen).** Retry the complete exit-state
   reconciliation a bounded number of times. Only accept `RunScriptStateMachineError` after a
   refreshed read confirms a consistent terminal state. Preserve the tracked child until the
   persisted state is reconciled. This is narrowly scoped and handles transient read, write, and
   post-write fetch failures.
2. **Retry inside the state machine.** This would cover all lifecycle transitions, but it would
   change latency and race semantics for start, stop, reset, and verification paths that are not
   implicated in this issue.
3. **Add a durable reconciliation queue.** This would survive repeated database outages and
   process restarts, but it requires new persistence and scheduling machinery disproportionate to
   this localized failure mode.

## Design

`RunScriptService` will reconcile the exit outcome before removing the child from
`runningProcesses` or clearing output listeners. The handler first requires positive ownership:
the tracked process must be the exact child that emitted the event. An untracked event is stale
because every live handler was registered only after its child was stored; another stop/error path
that removes the entry owns reconciliation. Each persistence attempt then reads the current
workspace status:

- `STOPPING` transitions to `IDLE` through `completeStopping()`.
- `STARTING` or `RUNNING` transitions to `COMPLETED` for exit code zero and `FAILED` otherwise.
- `IDLE`, `COMPLETED`, and `FAILED` are already consistent and require no write.
- A missing workspace or an unrecognized state is a persistence/reconciliation failure.

The service will make three immediate attempts. Immediate retries avoid introducing timers into
the child-process event path while still recovering common transient SQLite or connection errors.
Every retry logs a persistence-specific warning. After the last failure, the service logs an error
and rejects so the registered event wrapper escalates it through the existing error log.

A `RunScriptStateMachineError` is not swallowed by type alone. The service refreshes the workspace
and accepts the race only when the refreshed status is `IDLE`, `COMPLETED`, or `FAILED`. A refresh
failure or an active status continues through the bounded retry path. Non-state-machine errors are
always treated as persistence failures.

Only after reconciliation succeeds does the handler stop the captured post-run process, delete the
tracked child, clear listeners, and stop the tunnel. It rechecks exact child ownership both before
cleanup and after the awaited post-run kill. If ownership changes at either asynchronous boundary,
the old handler leaves the new run's process, listeners, post-run process, and tunnel alone. Every
asynchronous process callback (main-process spawn error/tree-kill and post-run exit/error/tree-kill)
also deletes a map entry only when its captured process still owns that entry. If reconciliation
exhausts its attempts, the tracked exited child and listeners remain available as lifecycle
evidence and cleanup does not make the stale state appear successfully finalized.

## Testing

Focused unit tests in `run-script.service.test.ts` will cover:

- a successful exit whose first `markCompleted()` call fails with a database error and succeeds on
  retry;
- a failed exit whose `markFailed()` calls exhaust all attempts, rejects the handler, and retains
  the tracked child/listeners without running terminal cleanup;
- an expected state-machine race that is accepted only after a refresh confirms a terminal state;
- a state-machine error whose refresh remains active, proving it is retried and ultimately
  escalated rather than swallowed;
- `STOPPING` persistence using the same retry behavior.
- a newer process installed while exit persistence is pending, proving the old handler cannot
  remove its resources.
- an untracked old exit while a new generation is starting, proving stale events cannot persist an
  outcome for the new run;
- replacement processes installed across post-run cleanup and asynchronous process callbacks,
  proving old completions cannot delete or stop new-generation resources;
- a post-write fetch failure whose retry observes the already-durable terminal state without
  repeating the transition write.

No UI or schema changes are required.
