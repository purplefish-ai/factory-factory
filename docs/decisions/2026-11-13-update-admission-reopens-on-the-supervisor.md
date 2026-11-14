# Update admission reopens only on the supervisor's word

Originally decided on 2026-11-04 in #2976.

## Context

An application update first drains agent work in the backend: the update job
waits until nothing holds the admission gate, closes it and sends `update-ready`
to the CLI supervisor. The supervisor may start preparing the moment that
message arrives, while the backend still treats the update as waiting. A user
can cancel in that window.

## Decision

After `update-ready` has been sent, cancelling forwards `update-cancel` to the
supervisor but does not reopen admission. Only an `idle` or `failed` status from
the supervisor, or a failed send to it, reopens it, because preparation may
already have started. Before `update-ready`, cancelling returns the job to
`idle` directly.

Rejected: reopening admission as soon as the backend cancels, which would admit
new agent work while preparation may already be under way.

## Consequences

- A cancel that races readiness leaves new agent work rejected until the
  supervisor answers.
- If the cancel cannot reach the supervisor, the job reports a failed update,
  and that failure reopens admission.
