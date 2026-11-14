# Background jobs

This note has moved. Read:

- The [backend process guide](../../src/backend/AGENTS.md) for the "Recurring
  work" rules for `jobRunner` (its pacing, abort and drain are in the header
  comment and tests of `src/backend/services/job-runner.service.ts`), the
  shutdown plan, its drain order and fatal errors.
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

> It performs no registry or installation work; the cached release service owns
> registry checks and the CLI supervisor owns installation.

Old paragraph 1. For the application-update capsule guide
(`src/backend/services/application-update/`), which pull request #3242 (task
2.4a) adds; if it is on `main` when the entry is read, check the ownership line
against the code and move it there.

> […] waits for envelopes in flight to settle […]

Old paragraph 17. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`), which task 2.6d (the Slack part of
`docs/architecture/integrations.md`) extends: it is about
`SlackEventSource.stop()`. No test fails when it stops waiting for envelopes in
flight; the sockets disconnecting and the stop being recorded are pinned by
`slack-intake.orchestrator.integration.test.ts`.

> […] an unresolved decision left by a removed trigger is still settled.

Old paragraph 18. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`, task 2.6c: the evaluation and filter
sections of `docs/architecture/integrations.md`).

> Expiry and retry gates use time captured after acquiring the ledger write
> lock.

Old paragraph 19. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`, task 2.6c): the retry gates belong
with the evaluation and filter sections.

> Non-dispatching decisions retain an explicitly marked configuration snapshot
> that admission cannot use.

Old paragraph 20. For the agent-definition capsule guide
(`src/backend/services/agent-definition/`, task 2.6c): non-dispatching decisions
are the classifier's skip and uncertain outcomes.
