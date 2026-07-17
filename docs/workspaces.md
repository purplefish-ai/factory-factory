# Workspace Progression Model

This document defines the workspace lifecycle, Kanban ownership, and PR Ratchet model.

Goals:

- one clear mental model for workspace progression;
- one canonical derivation for `WORKING`, `WAITING`, and `DONE`;
- distinct signals for live session activity and background PR/Ratchet activity;
- explicit handling for human-attention states, exhausted retries, and archive behavior.

## Terms

- `workspace.status`: provisioning lifecycle (`NEW`, `PROVISIONING`, `READY`, `FAILED`,
  `ARCHIVING`, `ARCHIVED`).
- `prState`: high-level pull-request state (`NONE`, `DRAFT`, `OPEN`,
  `CHANGES_REQUESTED`, `APPROVED`, `MERGED`, `CLOSED`).
- `prCiStatus`: cached CI snapshot (`UNKNOWN`, `PENDING`, `SUCCESS`, `FAILURE`).
- `ratchetEnabled`: workspace-level toggle for automated PR progression.
- `ratchetState`: Ratchet machine output (`IDLE`, `CI_RUNNING`, `CI_FAILED`,
  `MERGE_CONFLICT`, `REVIEW_PENDING`, `READY`, `MERGED`).
- `flowPhase`: derived PR/Ratchet phase (`NO_PR`, `CI_WAIT`, `RATCHET_VERIFY`,
  `RATCHET_FIXING`, `READY`, `MERGED`).
- `ciObservation`: interpretation of the cached CI snapshot:
  - `NOT_FETCHED`: the PR exists but has no fetched snapshot;
  - `NO_CHECKS`: an old enough snapshot reports no checks;
  - `CHECKS_PENDING`, `CHECKS_FAILED`, `CHECKS_PASSED`, or `CHECKS_UNKNOWN`.
- `isWorking`: live agent-session activity only. PR/CI/Ratchet progress does not set this
  field; that background ownership is represented by `flowPhase` and `flowIsWorking` when
  deriving the Kanban column.
- `statusReason`: derived user-facing reason such as `Needs permission`, `Waiting for CI`,
  `No session started`, or `Fixing review comments`.

## Sources of Truth

PR/Ratchet flow is derived in:

- `src/backend/services/workspace/service/state/flow-state.ts`

Next-action ownership and the Kanban column are derived in:

- `src/backend/services/workspace/service/state/kanban-state.ts`

The derived outputs are assembled and projected by:

- `src/backend/lib/workspace-derived-state.ts`;
- `src/backend/services/workspace/service/query/workspace-query.service.ts`;
- `src/backend/trpc/workspace.trpc.ts`.

The service-level `isWorking` output remains session-only even when the resulting Kanban
column is `WORKING` because CI or Ratchet automation owns the next action.

## Lifecycle State Machine

Workspace provisioning transitions are enforced by
`src/backend/services/workspace/service/lifecycle/state-machine.service.ts`:

- `NEW -> PROVISIONING`;
- `PROVISIONING -> READY | FAILED`;
- `READY -> ARCHIVING | PROVISIONING`;
- `FAILED -> PROVISIONING | NEW | ARCHIVING`;
- `ARCHIVING -> READY | FAILED | ARCHIVED`;
- `ARCHIVED` is terminal.

Invalid transitions throw `WorkspaceStateMachineError`. Lifecycle transitions also refresh
the cached Kanban column when the target is not `ARCHIVING` or `ARCHIVED`.

## PR and Ratchet Progression

The Ratchet capsule is implemented in
`src/backend/services/ratchet/service/ratchet.service.ts`. Its monitor loop uses the shared
`SERVICE_INTERVAL_MS.ratchetPoll` interval of two minutes. It evaluates `READY`,
Ratchet-enabled workspaces with PRs, refreshes their Ratchet state from live GitHub data, and
dispatches fixer sessions when the decision policy requires one.

The PR scheduler in `src/backend/orchestration/scheduler.service.ts` uses
`SERVICE_INTERVAL_MS.schedulerPrSync` to sync stale PR snapshots and discover new PRs every
three minutes. Manual `syncPRStatus` calls and these periodic syncs converge cached PR state.

Enabling Ratchet through `workspace.toggleRatcheting` also starts a background
`ratchetService.checkWorkspaceById(...)` evaluation so the workspace does not have to wait for
the next two-minute monitor cycle.

## Kanban as Next-Action Ownership

`computeKanbanColumn(...)` accepts:

- `lifecycle`;
- `sessionIsWorking`;
- `flowIsWorking`;
- `prState`;
- `ratchetState`;
- `pendingRequestType`;
- `hasSessionRuntimeError`;
- `ratchetDispatchOutcome`;
- `ratchetDispatchRetryCount`.

`hasHadSessions` is not a Kanban input. A `READY` workspace with no live owner falls through to
`WAITING`, whether or not it had an earlier session.

The rules are evaluated in this order:

| Priority | Condition | Column | Next-action owner |
| --- | --- | --- | --- |
| 1 | Lifecycle is `ARCHIVING` or `ARCHIVED` | `null` | Hidden from the active board |
| 2 | PR is merged/closed, or Ratchet observed `MERGED` | `DONE` | Terminal |
| 3a | Lifecycle failed, a request awaits input, or a session has a runtime error | `WAITING` | Human |
| 3b | A `DIED` Ratchet dispatch reached the configured retry limit | `WAITING` | Human |
| 4 | Lifecycle is `NEW`/`PROVISIONING`, a session is live, or PR/Ratchet flow is active | `WORKING` | Setup, agent, CI, or Ratchet automation |
| 5 | Any remaining nonterminal workspace | `WAITING` | Human |

The exhausted-retry rule deliberately overrides an otherwise active Ratchet flow. The limit is
`SERVICE_THRESHOLDS.ratchetDispatchMaxRetries` (currently 3). A `COMPLETED` dispatch outcome by
itself does not force `WAITING`. After a fixer exits cleanly, Ratchet continues monitoring PR and
CI state but suppresses another fixer dispatch while the dispatch snapshot is unchanged. A later
snapshot change re-enables normal Ratchet evaluation.

Archived workspaces retain their last pre-archive `cachedKanbanColumn`; the live derivation
returns `null` so they remain off the active board unless archived items are explicitly shown.

## Cached and Live State Propagation

Persisted snapshot entries include `ratchetDispatchOutcome` and
`ratchetDispatchRetryCount`, so reconciliation and snapshot-derived Kanban state apply the same
exhausted-retry rule as full workspace queries.

Ratchet dispatch changes publish `ratchet_dispatch_changed` after successful dispatch-record
mutations. The event collector immediately updates both snapshot fields and starts a
fire-and-forget refresh of the durable cached Kanban column. Ratchet state and toggle events use
the same cache-refresh path. Session activity remains a live overlay and is the only source of
the public `isWorking` flag.

## Ratchet Animation

The Ratchet button animates only when `flowPhase === 'CI_WAIT'` and Ratchet is enabled. Push
interceptors and other utility animation triggers are not part of the current model.

## Invariants

1. Archive state is handled before every visible Kanban column.
2. Terminal PR state wins over human-attention and automation-owned states.
3. Human-attention state and exhausted Ratchet retries win over active session or flow state.
4. `isWorking` reports session activity only; Kanban `WORKING` may instead be owned by setup,
   CI, or Ratchet automation.
5. `CIStatus.UNKNOWN` is interpreted through `ciObservation`, including the grace period before
   it becomes `NO_CHECKS`.
6. Enabling Ratchet triggers an immediate background evaluation.

## Testing Coverage

Key tests are located at:

- PR/Ratchet flow derivation:
  `src/backend/services/workspace/service/state/flow-state.test.ts`;
- next-action ownership and cache behavior:
  `src/backend/services/workspace/service/state/kanban-state.test.ts`;
- lifecycle transitions and lifecycle-driven cache updates:
  `src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts`;
- query projections:
  `src/backend/services/workspace/service/query/workspace-query.service.test.ts`;
- Ratchet behavior, dispatch retries, and disable semantics:
  `src/backend/services/ratchet/service/ratchet.service.test.ts`;
- Ratchet visual-state helpers: `src/components/workspace/ratchet-state.test.ts`;
- snapshot propagation and reconciliation:
  `src/backend/services/workspace-snapshot-store.service.test.ts` and
  `src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`;
- live event propagation: `src/backend/orchestration/event-collector.orchestrator.test.ts`.
