# Scheduled runs are reserved once and never replayed

Originally decided on 2026-06-27 in #1798 (issue #1753); the launch snapshot was
added on 2026-11-02 in #2815, and the shared timer dispatch on 2026-10-29 in
#2640.

## Context

A scheduled automation's run spans a database reservation, a workspace launch
and a link from the run to that workspace. When the schedule advanced before the
workspace was created and the execution was recorded only afterwards, a failed
creation skipped the run silently, with nothing left to monitor (#1753). Later,
a definition edited after the poll's due-task read could launch its old
instructions or advance an obsolete calendar (#2815).

## Decision

One transaction rereads the task by ID, checks that it is enabled, due, in an
active project and not already running, creates a `RUNNING` execution and
advances the schedule. The execution stores a versioned launch snapshot, and
dispatch launches only from that snapshot. A launch failure marks the run
`FAILED` and keeps the advanced schedule; a run whose workspace link was never
written fails after 15 minutes. Restart does not re-emit reserved runs.

Executions created before the snapshot existed keep a null snapshot: their
instructions cannot be reconstructed safely from today's definition.

Rejected:

- Replay or an exactly-once guarantee for a run that was admitted.
- Moving scheduled automations into `AgentRun`, or giving timer events a second
  run store, a PR ledger entry, session queue delivery or a receipt protocol.
- Filling legacy snapshots from the current definition.

## Consequences

- An admitted slot launches at most once; a failed one is not retried, and the
  next run waits for the following slot.
- A crash between the launch and the link leaves a workspace whose run fails at
  the timeout.
- Edits after admission never change a run already admitted.
