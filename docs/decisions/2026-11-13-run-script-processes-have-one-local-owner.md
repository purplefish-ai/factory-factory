# Run-script processes have one local owner

Originally decided on 2026-10-30 in #2722 (postRun) and on 2026-11-13 in #3202
(execution ownership).

## Context

A run attempt involves asynchronous steps (workspace and configuration reads,
port allocation, tunnel startup) during which the user can stop the script or
start a replacement. Stop and exit cleanup act on the processes they can see
when they run, so a process spawned after them escapes cleanup, and a callback
from an old attempt could remove or reconcile its replacement.

## Decision

`RunScriptService` indexes one current `RunScriptExecution` per workspace. Each
execution owns its main process, postRun process, stop intent and exit
observation, and it is registered before the workspace and configuration reads.

- Stop intent is independent of whether the main process has exited. It revokes
  pending continuations, so a stopped port allocation cannot spawn and postRun
  cannot start while the user's cleanup command runs.
- postRun starts only if its run script is still live after tunnel startup,
  because stop and exit cleanup would not see a postRun spawned later.
- An old execution's callbacks cannot remove a replacement's registry entry, and
  tunnel leases release only the resources they captured.
- The persisted status machine stays separate from this process ownership; a
  terminal status can precede resource cleanup.

Rejected: durable cross-process fencing. This ownership is local to one backend
process.

## Consequences

- Stop, exit and replacement races cannot leak a postRun or kill a replacement.
- After a backend restart, ownership starts empty; the persisted pid is the only
  link to an orphaned process.
