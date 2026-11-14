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
also owns saved edits, proposals, history reads, Enable, Pause, source reset,
Delete, retention and the Slack listener. It does not own:

- Scheduled automations: `src/backend/services/periodic-task/`.
- The runtime jobs, their GitHub and Slack wiring, native execution validation,
  source discovery and draft validation: `src/backend/orchestration/agents/`.
- GitHub reads and the issue-event parser: `src/backend/services/github/`.
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

`index.ts` names it: the management, proposal, activation, source poll,
evaluation, run monitor, ledger retention, Slack connection and Slack event
source services and the workspace retry authority; the ledger primitives; the
run launch, execution binding, initial delivery, recovery and result owners; the
matcher and trigger capability; re-exported shared schemas; and the backup
functions for definitions and Slack connections.

## Invariants

- Credentials are stored only encrypted on `AgentConnection`, and public
  connection reads return metadata and credential presence only.
  `service/slack-connection.integration.test.ts`,
  `service/slack-app-token.integration.test.ts`.
- A GitHub trigger becomes `ACTIVE` only when its own STARTING generation's
  baseline resolves, at that boundary.
  `src/backend/testing/agent-runtime-flow.integration.test.ts`,
  `src/backend/trpc/agent-activation.integration.test.ts`,
  `service/agent-activation.integration.test.ts`.
- Activation and admission require a `validatedIntent` for the current
  `definitionRevision`; admission also requires `isConfigured = true`.
  `service/agent-activation.integration.test.ts`.
- Delete refuses, rolling back its pause, while any run is `RUNNING`.
  `service/agent-delete.integration.test.ts`.
- Enable, Pause, Delete and source reset are trusted-local only, and the MCP
  authoring catalog has none of them.
  `src/backend/trpc/agent-delete.integration.test.ts`,
  `src/backend/mcp/automation-authoring-tools.test.ts`.
- Management reads and writes are scoped to the owning project: another
  project's IDs read as `NOT_FOUND`.
  `src/backend/trpc/agent-management.integration.test.ts`,
  `src/backend/trpc/agent-list.integration.test.ts`.
- A saved edit and an accepted-proposal edit each increment both
  `managementRevision` and the proposal's `revision` once, a rename included, so
  a stale editor on either path gets a `CONFLICT`.
  `service/agent-management-owner.integration.test.ts`.
- While any trigger's `isConfigured` is null, `get` returns no specification,
  and a saved replacement that includes that trigger pauses it as changed.
  `service/agent-management-owner.integration.test.ts`.
- A proposal creates its automation paused and once; a repeated acceptance
  returns it only for the same revision and specification.
  `service/agent-proposal.integration.test.ts`.

Trusted-local checks the socket address, Origin and forwarding headers, so any
local process passes it, an agent included.

## Map

- `service/agent-management.service.ts`: saved definitions, edits, Delete and
  reset; `service/agent-activation.service.ts`: Enable and Pause.
- [Service guide](service/AGENTS.md): evaluation, natural-language filters and
  history reads.
- [Resources guide](resources/AGENTS.md): the run ledger and GitHub source
  proof, with their invariants, map and decision records.
