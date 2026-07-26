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
- `ratchetState`: projection of the PR observation, never stored (`IDLE`,
  `CI_RUNNING`, `CI_FAILED`, `MERGE_CONFLICT`, `REVIEW_PENDING`, `READY`,
  `MERGED`). See "Where Ratchet State Lives".
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

Invalid transitions throw `WorkspaceStateMachineError`.

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
PR identity, state, CI-status, or review-decision aggregate change clears settled dispatch
ownership immediately, returning an exhausted workspace to normal automation ownership before
the next Ratchet poll. Identical periodic refreshes do not clear exhaustion. The dispatch
snapshot key itself stays intact, so Ratchet still decides whether the changed aggregate actually
warrants another fixer.

Archiving and archived workspaces derive a `null` column, which keeps them off the active board.
The column is never persisted: `computeKanbanColumn` runs on every read, so the board, the
sidebar, the snapshot stream, and the child-workspace panel cannot disagree about it.

There is also one project-scoped read behind it. `workspace.listForProject` returns every live
workspace in a project with its derived state, and the board and the sidebar select what they
render from that single list — the board dropping rows whose column is `null`. Column-wide
actions use `findWorkspaceIdsInKanbanColumn`, which derives the column rather than filtering in
SQL, because live session state is not in the database.

## Where the PR Cache Lives

Everything the app knows about a workspace's pull request is a 1:1 `WorkspacePR` row rather than
thirteen columns on `Workspace`: `url`, `number`, `state`, `reviewState`, `ciStatus`, `syncedAt`,
the three `discovery*` scheduling fields, `ciFailedAt`, `ciLastNotifiedAt`, and the two
`reviewLast*` cursor fields. `workspace-pr.accessor.ts` is the only writer.

The split says something the old layout hid: this is a cache, not a source of truth. Every field is
a copy of GitHub state or a cursor into it, and losing the whole row costs one refresh. Sitting
beside the workspace's own durable identity, that was invisible.

A row is created with every workspace, including workspaces with no PR, because PR discovery claims
its backoff on this row before any PR exists.

Reads flatten the row back onto the workspace under the old `pr*` names, so derived state, the
snapshot stream, the v4 backup format and the client see the shape they always did. `syncedAt` is
the one rename: on `Workspace` it was `prUpdatedAt`, which read as GitHub's PR `updated_at` but
always held the caller's own observation time.

Two consequences worth knowing:

- **Discovery polling no longer counts as workspace activity.** Claiming a discovery attempt used
  to write a `Workspace` column, which bumped `updatedAt` and floated PR-less workspaces to the top
  of any `updatedAt`-ordered list on every poll. The claim now writes only its own row. The
  compare-and-swap is unaffected — the retry count still moves — and the guards on `status`,
  `branchName` and `updatedAt` are relation filters.
- **Three composite indexes are gone.** `[status, prUrl]`, `[status, prUrl, prDiscoveryNextCheckAt]`
  and `[status, prUpdatedAt]` cannot span two tables. The PR-sync and PR-discovery queries are now
  joins, filtering `status` on `Workspace` and the rest against indexes on `WorkspacePR`.

## Where Ratchet State Lives

Nowhere: `ratchetState` is not stored. It is a pure function of the PR observation, computed by
`deriveRatchetState` (`src/shared/core/ratchet-state.ts`) from `ratchetEnabled` plus four
`WorkspacePR` columns — `state`, `ciStatus`, `reviewState` and `hasMergeConflict`. The projection
happens at the accessor boundary that already flattens the side tables, so every read that used to
get a column gets a computed value under the same name, and no write can put the two out of step.

What that replaced:

- **A 127-line transition table** (`ratchet-state-machine.ts`) that permitted all 49 of its 49
  state pairs. `isValidRatchetTransition` could not return false and
  `assertValidRatchetTransition` could not throw. Its own header called it "a tripwire for future
  refactors rather than restricting today's graph"; it was documentation, and it is gone along with
  its 89-line test.
- **A compare-and-swap on `state`**, which existed to keep the `fromState` on
  `RATCHET_STATE_CHANGED` accurate. No consumer of that event reads `fromState` or `toState` — the
  handler enqueues `prCiStatus` and asks for an authoritative re-projection. The CAS on `enabled`
  survives, because "was ratcheting disabled while this check ran" is a real question; the state
  half is gone, and with it the `superseded` branch in `finishRatchetCheck`.
- **Two settling writes.** Disabling a workspace, and `markPrClosed` with its three-attempt CAS
  retry loop, both existed to force `state` to `IDLE`. A disabled workspace and a closed PR both
  derive to `IDLE`, so the toggle and the PR sync are now the whole transition — and the window in
  which `ratchetState` disagreed with `ratchetEnabled` is closed by construction.

**One column was added, not just removed.** `WorkspacePR.hasMergeConflict` (GitHub's
`mergeStateStatus == DIRTY`) was observed on every ratchet fetch but never persisted: the ratchet
folded it into `RatchetState.MERGE_CONFLICT` and stored that. So the trade is one derived enum
column for one observed boolean.

The migration backfills it from `state = 'MERGE_CONFLICT'`, which under-reports: a failing build
outranked a conflict in the derivation, so a PR with both was stored as `CI_FAILED` and migrates as
clean. That is accepted rather than patched. The dispatch snapshot key carries a conflict too
(`|merge:conflict`) but it records whenever the last fixer was dispatched, not the last observation,
so it cannot distinguish a live conflict from one resolved after its dispatch. While CI is failing the derivation returns
`CI_FAILED` and never reads the flag, and a ratchet check that turns CI green writes the true flag in
the same statement — but the PR-sync poller writes `ciStatus` without touching `hasMergeConflict`, so
if it observed green first the derivation would report `READY` for a PR GitHub still calls `DIRTY`.

So the migration nulls `lastCheckedAt` on exactly those rows — open PRs whose ratchet state was
`CI_FAILED`, the only state that could mask a conflict. The ratchet poll orders by `lastCheckedAt`
ascending and SQLite sorts NULLs first, so they are re-observed on the first cycle after the
migration and the flag is established from a live fetch rather than guessed at. Over-reporting would
be visible — a spurious conflict badge, and a conflict fixer dispatched against a clean PR — which is
why no value is inferred.

**The ratchet check persists the whole observation, not just CI.** This is the part that makes the
projection sound: `ratchetState` is read from the cache, so anything a check saw and kept to itself
is something no later read can derive. That used not to matter — the check wrote its conclusion
straight into a `state` column, so a merge or a new changes-requested review reached the app even
while the cache lagged the PR-sync poller. `recordPrObservation` now writes `prState`,
`prReviewState`, `prCiStatus` and `hasMergeConflict` together, mapping the raw observation through
the github capsule's own `computePRState` so both writers of `WorkspacePR.state` agree on what
`DRAFT` and `APPROVED` mean. The write is guarded on the PR number the observation was fetched
for: the aggregate compare-and-swap reads its guard inside the write transaction, so it catches a
racing write but not a workspace re-pointed at a new PR while the check was off fetching — and a
stale `MERGED` stamped onto a fresh PR would drop it out of the ratchet poll set. A null cached
number is treated as "not known yet", since discovery attaches a url without a number.

`recordPrObservation` also publishes `PR_SNAPSHOT_UPDATED` for every applied write, the
same event the PR-sync poller publishes — otherwise a merge the ratchet saw first would reach the
database and stop there, leaving the client on `OPEN` and the linked Linear issue uncompleted until
the poller came round. `PR_DISPATCH_INVALIDATED` is gone: it had one emitter and one handler and
fired only when a settled dispatch was reset, which is now carried as `ratchetDispatchChanged` on
the snapshot event. The conflict flag also joins the aggregate change detector and its
compare-and-swap guard, so a conflict appearing or clearing invalidates a settled dispatch like any
other aggregate field and the two writers cannot race.

**Behaviour changes worth knowing:**

- A PR snapshot update now always triggers an authoritative ratchet projection, where it used to do
  so only when the dispatch record moved. That is what stops a snapshot showing `prState: MERGED`
  next to a `ratchetState` left over from the previous ratchet poll.
- The ratchet poll set reads both closed and merged off `WorkspacePR.state`. It used to ask two
  tables — `pr.state != CLOSED` and `ratchet.state != MERGED` — for the same fact.

The rest of the row is genuinely mutable and still stored: `enabled`, `lastCheckedAt`,
`activeSessionId`, `dispatchSnapshotKey`, `dispatchOutcome`, `dispatchRetryCount`.
`workspace-ratchet.accessor.ts` is the only writer, enforced by the owned-side-table rule in
`check-single-writer`. `enabled` stays next to the dispatch record because every conditional ratchet
write guards on it in the same statement it writes.

Reads flatten the row back onto the workspace under the old `ratchet*` names, so derived state,
the snapshot stream and the client see the shape they always did. `dispatchSnapshotKey` is the one
rename: on `Workspace` it was `ratchetLastCiRunId`, whose schema comment described it as a
misnomer kept to avoid a migration. It holds the full dispatch snapshot key — PR number, CI
signature, review activity, merge conflict — not a CI run id.

A row is created with every workspace, so no workspace can exist that the row-guarded writes would
silently skip. The backup format still carries the fields flat, under the old names, because it is
required at `schemaVersion: 4` with no migration path.

## Cached and Live State Propagation

Persisted snapshot entries include `ratchetDispatchOutcome` and
`ratchetDispatchRetryCount`, so reconciliation and snapshot-derived Kanban state apply the same
exhausted-retry rule as full workspace queries.

Ratchet dispatch changes publish `ratchet_dispatch_changed` as an invalidation after successful
dispatch-record mutations. PR resets and Ratchet toggles use the same invalidation model. The
event collector serializes and coalesces those invalidations per workspace, re-reads the
authoritative Ratchet fields from the database, and reruns the projection when another mutation
lands during a read. This prevents a delayed older callback from overwriting a newer dispatch or
reset. Direct Ratchet CI observations use the same aggregate-change reset and full dispatch-tuple
compare-and-swap as scheduled PR snapshots, so `FAILURE` to `PENDING` clears exhausted ownership
without overwriting a concurrent `RUNNING` fixer. Fresh `prCiStatus` observations still travel
directly on Ratchet state events, while `ratchetState` is always re-read authoritatively — which,
now that it is derived, means recomputed from the PR row rather than re-read from a column. Projection
reads retry transient failures with bounded backoff and are cancelled on collector stop or
reconfiguration.

Durable cached-column refreshes serialize their complete read/derive/write operation per
workspace and retry transient failures. Their final write is conditional on the lifecycle and
ownership tuple that was read; a lifecycle or Ratchet race causes a fresh derivation instead of a
stale write, preserving archived columns. Event-collector timestamps are strictly monotonic so
later same-millisecond updates cannot be rejected as stale by the snapshot store. The collector
owns and removes every domain listener and cancels pending projection/coalescer work on stop or
reconfiguration. Session activity remains a live overlay and is the only source of the public
`isWorking` flag.

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
