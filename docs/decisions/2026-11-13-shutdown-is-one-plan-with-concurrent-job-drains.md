# Shutdown is one plan with concurrent job drains

Originally decided on 2026-11-03 in #2870 (concurrent drains) and on 2026-11-09
in #3100 (one plan for both teardown paths).

## Context

Server shutdown stopped most background jobs one after another near the end of
teardown, so it waited for the sum of their in-flight runs, and until then a job
could start new work while sessions were already closing. `disposeApplication`,
which tears down a graph no server took ownership of, kept its own list, and the
two had drifted: server shutdown neither cancelled in-flight Codex logins nor
called `jobRunner.stopAll()` before the database disconnected.

## Decision

`createShutdownPlan` in `src/backend/application-shutdown.ts` is the only
teardown list. Server shutdown and `disposeApplication` both run it; the server
adds only its transport and timer work, through two hooks at fixed points.

The plan signals the jobs in its `jobs` list as soon as shutdown begins, so none
of them starts new work during teardown, and lets their in-flight runs drain
concurrently with each other and with the ordered steps. A step waits only for
the drains it depends on, and every drain settles before the database
disconnects.

Among the waits that remain, the event collector keeps projecting until the PR
poll has settled; snapshot reconciliation's Git pass settles before the Git
state service drops its watchers and cache; launcher-option and Codex
model-catalog discovery still read account context, so Codex account teardown
waits for them. Jobs that a step stops instead, such as the agent runtime's or
workspace metadata's, run until that step; `jobRunner.stopAll()` is a backstop
for a registered job the plan does not name.

Rejected:

- Stopping jobs one at a time, which costs the sum of their in-flight runs.
- A teardown list per path, which is how the two paths drifted.

## Consequences

- The job drains together cost about as much time as the slowest of them; the
  ordered steps add their own time.
- Startup checks for shutdown after each await before it starts more jobs: a job
  started after its stop would keep running with nothing left to stop it before
  the database disconnects.
- A failed drain or step is reported but does not stop the rest of the plan.
- Why startup recovery's drain is awaited only after sessions stop is in
  [Slow startup recovery runs after readiness](2026-11-13-slow-startup-recovery-runs-after-readiness.md).
