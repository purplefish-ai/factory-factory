# Agent-definition capsule

Event-triggered automations: saved instructions that start a fresh workspace
when a GitHub issue event or a Slack message matches one of their triggers. The
UI calls an `AgentDefinition` an automation. The [services guide](../AGENTS.md)
covers capsule layout and boundaries. Paths that start with `service/` or
`resources/` are in this directory; paths that start with `src/` are from the
repository root.

## Owns, and does not own

This capsule owns thirteen models. `AgentDefinition` (instructions, execution
settings, `definitionRevision` for execution edits, `managementRevision` for
management writes, `validatedIntent` from Enable), `AgentTrigger` (`config`,
`isConfigured`, activation state, generation and boundary), `AgentConnection` (a
Slack workspace or a GitHub repository, `gh:<repository-id>`) and
`AgentProposal` (a chat draft) are authoring. `AgentEvent`, `AgentEvaluation`,
`AgentRun` and `AgentInitialDelivery` are the ledger; a `QUEUED` run is a
reservation, not a started agent. `AgentSourceState`, `AgentSourcePage`,
`AgentSourceCheckpoint`, `AgentSourceHead` and `AgentSourceBaseline` hold the
GitHub feed's state and proof; proof rows carry the `epoch` that wrote them. It
also owns Enable, Pause, source reset, Delete, retention and the Slack listener.
It does not own:

- Scheduled automations: `src/backend/services/periodic-task/`.
- The runtime jobs, their GitHub and Slack wiring, native execution validation
  and Enable's draft validation: `src/backend/orchestration/agents/`.
- GitHub reads and the issue-event parser, under the shared `gh` budget:
  `src/backend/services/github/`.
- The `automation` tRPC namespace, `src/backend/trpc/agent.trpc.ts`, and the
  agent tools in `src/backend/mcp/automation-authoring-tools.ts`.
- Workspaces and their launch origins, sessions, the backup file and the
  Automations page: the workspace and session capsules,
  `src/backend/orchestration/data-backup/` and `src/client/features/agents/`.
- Limits and the retention policy: `configService.getAgentRuntimeLimits()`.
- Shared schemas: `src/shared/schemas/agent-definition.schema.ts`,
  `src/shared/agent-runtime.ts`, `src/shared/agent-management.ts` and
  `src/shared/agent-run-context.ts`.

## Public surface

`index.ts`: the management, proposal, Slack connection, source poll, activation,
evaluation, run monitor and ledger retention services; the persistence
primitives `ingestEvent`, `finalizeEventOrder`, `recordEvaluation`, `admitRun`,
`claimNextRun` and `maintainQueue`; the launch, recovery and result owners;
`matchAgentEvent` and `triggerCapability`; re-exported shared schemas; and the
backup functions for definitions and Slack connections.

## Invariants

- Credentials are stored only encrypted on `AgentConnection`, and public
  connection reads return metadata and credential presence only.
  `service/slack-connection.integration.test.ts`,
  `service/slack-app-token.integration.test.ts`.
- Admission rechecks the revisions, activation generation, trigger, connection,
  source readiness and project inside the ledger transaction.
  `resources/agent-ledger.integration.test.ts`.
- One definition and event admit at most one run, owned by the first matching
  trigger in ID order; an earlier pending or errored evaluation defers the rest.
  `resources/agent-ledger.integration.test.ts`.
- A claim counts every `RUNNING` run against the per-definition and global
  limits and advances the worker generation that fences older workers.
  `resources/agent-queue-bounds.integration.test.ts`,
  `resources/agent-prompt.integration.test.ts`.
- A GitHub event gets its `sourceOrder` only when its verified interval is
  finalized, in API order above the retained high water, never by arrival or
  provider ID. `resources/agent-ledger.integration.test.ts`,
  `service/agent-source-poll.integration.test.ts`.
- `RECOVERY_REQUIRED` survives every failure, page, finalization and baseline
  write until `resetSource` lifts it.
  `service/agent-source-recovery.integration.test.ts`.
- FINALIZED markers, head checkpoints and issued baselines are never compacted
  or pruned, so `getBaseline` keeps answering every issued ID.
  `resources/agent-source-checkpoint.integration.test.ts`.
- Only the current epoch's proof is authority, a reset's epoch starts at the
  retained high water, and an event captured before a reset never gets an
  ordinal. `service/agent-source-reset.integration.test.ts`.
- Pause, edits and source reset pause through `pauseTriggers`, which advances
  the generation and cancels only `QUEUED` runs.
  `service/agent-activation.integration.test.ts`,
  `resources/agent-revisions.integration.test.ts`,
  `service/agent-source-reset.integration.test.ts`.
- A GitHub trigger becomes `ACTIVE` only when its own STARTING generation's
  baseline resolves, at that boundary.
  `src/backend/testing/agent-runtime-flow.integration.test.ts`,
  `src/backend/trpc/agent-activation.integration.test.ts`.
- Activation and admission require a `validatedIntent` for the current
  `definitionRevision`; admission also requires `isConfigured = true`.
  `service/agent-activation.integration.test.ts`.
- Delete refuses, rolling back its pause, while any run is `QUEUED` or
  `RUNNING`. `service/agent-delete.integration.test.ts`.
- Enable, Pause, Delete and source reset are trusted-local only, and the MCP
  authoring catalog has none of them.
  `src/backend/trpc/agent-delete.integration.test.ts`,
  `src/backend/mcp/automation-authoring-tools.test.ts`.
- The navigation summary reads the raw-SQL index `AgentRun_latest_terminal_idx`,
  which Prisma cannot see; its query must match the index.
  `resources/agent-management-history.navigation-summary.integration.test.ts`.

GitHub's offset pages are not a snapshot: these checks detect observed
discontinuity, not every deletion or reordering. Pruning is not erasure;
provider conversations and evaluation snapshots have their own lifetimes.

## Map

- `resources/agent-ledger-transaction.ts`: the ledger writer lock.
- `service/agent-management.service.ts`: saved definitions, edits, Delete and
  reset; `service/agent-activation.service.ts`: Enable and Pause.
- `service/agent-source-poll.service.ts`, `resources/agent-source.accessor.ts`,
  `resources/agent-source-checkpoint.accessor.ts`: GitHub capture, verification,
  finalization and proof maintenance.
- `resources/agent-run.accessor.ts` (admission),
  `resources/agent-run-claim.accessor.ts` (claim) and
  `resources/agent-runtime-guards.ts` (eligibility for both).

## Decisions

- [GitHub source proof is retained](../../../../docs/decisions/2026-11-13-github-source-proof-is-retained.md)
- [Source reset opens a new epoch](../../../../docs/decisions/2026-11-13-source-reset-opens-a-new-epoch.md)
