# Recurring work runs on one sequential job runner

Originally decided on 2026-07-26 in #2035.

## Context

Five backend poll loops each hand-rolled the same lifecycle: a shutdown flag, an
in-flight promise, a guard against overlapping ticks and, in two of them, a
cancellable sleep. The copies had drifted apart. Three of the loops used
`setInterval`, so their runs landed on wall-clock boundaries and needed the
overlap guard. The shutdown flag was also read inside long batches, between
workspaces in the PR sync and before each PR monitoring check, so that a stop
partway through did not walk the whole list first.

## Decision

`jobRunner` (`src/backend/services/job-runner.service.ts`) owns the lifecycle of
every recurring job. Jobs are paced sequentially: the delay runs from the end of
one run to the start of the next, so a job cannot overlap itself and needs no
guard. Each run receives an `AbortSignal` that aborts on stop, which replaces
the shutdown flag inside batches.

Rejected:

- `setInterval` pacing with a skip-if-in-flight guard.
- A "run this job now" API. Both cancellable sleeps were only ever woken by
  their own `stop()`, so interruptibility is a shutdown concern, not a
  scheduling feature.
- Bounding how long `stop()` waits for a run in flight. That would change
  shutdown to abandon work mid-flight, a behaviour decision outside the
  consolidation.
- Moving process-local eviction timers, such as the rate limiter's, onto the
  runner: they do no database or network work and carry no shutdown-ordering
  hazard.

## Consequences

- A run that takes `d` ms pushes the next start to `interval + d`; no job lands
  on a wall-clock boundary.
- A wedged run, such as a hung `gh` call, holds up `stop()` and so shutdown
  until it settles.
- The loops' remaining differences became options: `runImmediately` for a first
  run at start, and `computeDelay`, read after every run, for the PR event
  poll's rate-limit backoff.
