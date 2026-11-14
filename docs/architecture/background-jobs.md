# Background jobs

This note has moved. Read:

- The [services guide](../../src/backend/services/AGENTS.md#job-runner) for
  `jobRunner`: pacing, abort, drain, and where cadences live.
- The [backend process guide](../../src/backend/AGENTS.md) for the shutdown
  plan, its drain order, startup interrupted by shutdown, and fatal errors.
- The
  [event automation orchestration guide](../../src/backend/orchestration/agents/AGENTS.md)
  for the event runtime's jobs and how they stop.
- The guide of the directory that registers any other job, such as the
  [pull request](../../src/backend/orchestration/pull-requests/AGENTS.md) and
  [periodic-task](../../src/backend/services/periodic-task/AGENTS.md) guides.

The reasons are in
[one sequential job runner](../decisions/2026-11-13-recurring-work-runs-on-one-sequential-job-runner.md)
and
[shutdown is one plan](../decisions/2026-11-13-shutdown-is-one-plan-with-concurrent-job-drains.md).
The tests the guides name describe the behaviour.

<a id="timer-dispatch-ownership"></a>Links here with this anchor were for the
event runtime's jobs: the
[event automation orchestration guide](../../src/backend/orchestration/agents/AGENTS.md).

This page remains while links from notes not yet migrated point here or the
section below holds entries; delete it when both are gone.

## Held for other guides

Rules and hazards from the old note that belong to another area. Each entry
quotes only the sentences it needs from the paragraph named after it, verbatim,
with `[…]` where sentences between them are left out, and has not been checked
against the code. The migration that creates the named area's guide checks the
entry, moves what holds there and deletes the entry here. Paragraph numbers are
the rows of the disposition table in the pull request that moved this note.

> The agent runtime's shutdown step stops the job and the adapter together: it
> disconnects every socket, waits for envelopes in flight to settle, and records
> the stop as a delivery gap before the database closes.

Old paragraph 17. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`), from the Slack slice of
`docs/architecture/integrations.md` (task 2.6d). No test fails when
`SlackEventSource.stop()` stops waiting for envelopes in flight.

> Expiry and retry gates use time captured after acquiring the ledger write
> lock.

Old paragraph 19. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`, task 2.6b).

> Non-dispatching decisions retain an explicitly marked configuration snapshot
> that admission cannot use.

Old paragraph 20. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`, task 2.6b).
