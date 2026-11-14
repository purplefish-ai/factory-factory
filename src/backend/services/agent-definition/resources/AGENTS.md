# Agent-definition resources: run ledger and GitHub source proof

This guide covers the accessors here that hold the event ledger (events,
evaluations, admission, claim and retention) and the GitHub feed's capture,
verification, finalization and proof, which the source poll service drives. The
[capsule guide](../AGENTS.md) covers the models, the public surface and the
other accessors here. Bare file names below are in this directory; paths that
start with `src/` are from the repository root.

## Owns, and does not own

This guide covers the ledger writer lock, the run ledger's admission, claim and
retention, `pauseTriggers`, and the GitHub source's pages, checkpoints, heads,
baselines and epochs. It does not own:

- When sources are polled: the poll service,
  `src/backend/services/agent-definition/service/agent-source-poll.service.ts`,
  and the runtime jobs in `src/backend/orchestration/agents/`.
- The other accessors here (definitions, proposals, activation, launch and
  Slack), and Enable, Delete and the `ACTIVE` transition: the capsule guide.

## Invariants

- Admission rechecks the revisions, activation generation, trigger, connection,
  source readiness and project inside the ledger transaction.
  `agent-ledger.integration.test.ts`.
- One definition and event admit at most one run, owned by the first matching
  trigger in ID order; an earlier pending or errored evaluation defers the rest.
  `agent-ledger.integration.test.ts`.
- A decision other than `MATCHED` keeps a `NON_DISPATCHING` snapshot, which
  admission rejects. `agent-ledger.integration.test.ts`.
- An unresolved decision of a trigger removed since is still offered to
  evaluation and settled there, never evaluated again.
  `src/backend/services/agent-definition/service/agent-event-evaluation.integration.test.ts`.
- A claim counts every `RUNNING` run against the per-definition and global
  limits and advances the worker generation that fences older workers.
  `agent-queue-bounds.integration.test.ts`, `agent-prompt.integration.test.ts`.
- Waiting-run expiry in a claim and in queue maintenance, and the cutoffs of the
  evaluation, payload and identity retention batches, use a time read after the
  ledger transaction holds the write lock.
  `agent-queue-clock.integration.test.ts`,
  `agent-ledger-retention.integration.test.ts`.
- A GitHub event gets its `sourceOrder` only when its verified interval is
  finalized, in API order above the retained high water, never by arrival or
  provider ID. `agent-ledger.integration.test.ts`,
  `src/backend/services/agent-definition/service/agent-source-poll.integration.test.ts`.
- `RECOVERY_REQUIRED` survives every failure, page, finalization and baseline
  write until `resetSource` lifts it.
  `src/backend/services/agent-definition/service/agent-source-recovery.integration.test.ts`.
- FINALIZED markers, head checkpoints and issued baselines are never compacted
  or pruned, so `getBaseline` keeps answering every issued ID.
  `agent-source-checkpoint.integration.test.ts`.
- Only the current epoch's proof is authority, a reset's epoch starts at the
  retained high water, and an event captured before a reset never gets an
  ordinal.
  `src/backend/services/agent-definition/service/agent-source-reset.integration.test.ts`.
- Pause, execution and trigger edits, and source reset pause through
  `pauseTriggers`, which advances the generation and cancels only `QUEUED` runs.
  `src/backend/services/agent-definition/service/agent-activation.integration.test.ts`,
  `agent-revisions.integration.test.ts`,
  `src/backend/services/agent-definition/service/agent-source-reset.integration.test.ts`.
- The navigation summary reads the raw-SQL index `AgentRun_latest_terminal_idx`,
  which Prisma cannot see; its query must match the index.
  `agent-management-history.navigation-summary.integration.test.ts`.

GitHub's offset pages are not a snapshot: these checks detect observed
discontinuity, not every deletion or reordering. Pruning is not erasure;
provider conversations and evaluation snapshots have their own lifetimes.

## Map

- `agent-ledger-transaction.ts`: the ledger writer lock.
- `agent-source.accessor.ts`, `agent-source-checkpoint.accessor.ts`: GitHub
  capture, verification, finalization and proof maintenance, driven by the poll
  service.
- `agent-evaluation-candidates.accessor.ts` (pending decisions),
  `agent-evaluation.accessor.ts` (recording them and their snapshots).
- `agent-run.accessor.ts` (admission), `agent-run-claim.accessor.ts` (claim) and
  `agent-runtime-guards.ts` (eligibility for both).
- `agent-trigger-pause.ts`: `pauseTriggers` and `cancelQueuedRuns`.
- `agent-management.accessor.ts`, `agent-revision.accessor.ts`,
  `agent-proposal.accessor.ts`: saved and proposal writes; their invariants are
  in the capsule guide.

## Decisions

- [GitHub source proof is retained](../../../../../docs/decisions/2026-11-13-github-source-proof-is-retained.md)
- [Source reset opens a new epoch](../../../../../docs/decisions/2026-11-13-source-reset-opens-a-new-epoch.md)
