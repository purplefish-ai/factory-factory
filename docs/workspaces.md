# Workspaces: Glossary and Progression Model

The [glossary](#glossary) is current. Everything after it is the
[historical progression model](#historical-progression-model).

## Glossary

UI labels use these terms. Code identifiers, APIs and database fields keep their
existing names, shown in parentheses where they differ.

- **Project**: a repository Factory Factory manages. Each project has one board.
- **Board**: the project's landing page (`/projects/:slug/workspaces`), with
  Todo, Working, Waiting and Done columns. Open it from **Board** in the sidebar
  or the project name in the header. The sidebar lists the same workspaces and
  preserves its open/closed preference across navigation.
- **Workspace**: one isolated Git worktree and branch, with its chats, terminals
  and pull requests. A workspace is what moves across the board. **New
  workspace** in the sidebar opens the new workspace; **New workspace** at the
  top of the board's Todo column (a main-pane toolbar shortcut on phones) stays
  on the board so several can be launched in a row. The retired
  `/projects/:slug/workspaces/new` URL opens the board's form.
- **Chat** (`session`): one conversation with a coding agent inside a workspace,
  shown as a tab such as "Chat 1". A workspace can have several. Search lists
  chats as **Chat** results.
- **Agent**: two senses. In status text such as "Agent working", the coding
  agent (Claude or Codex) running in a chat. As a saved object, an automation in
  the project's **Agents** section that launches workspaces: a **scheduled
  agent** (`PeriodicTask`) or an **event agent**. Labels for saved agents name
  the kind, as in a workspace's **Scheduled agent** tool tab.
- **Subagent** (`subagent`): a helper that the provider starts inside a chat. It
  works in the chat's workspace and appears in the workspace's **Subagents**
  tool tab and as a transcript tab. UI text spells it "subagent".
- **Child workspace**: a separate workspace, with its own branch and chats, that
  a workspace's agent creates for delegated work. The parent lists its children
  under **Child workspaces** in the **Subagents** tab, next to the other
  delegated work; board cards link parents and children.
- **Issue**: a GitHub or Linear issue assigned to you, shown in the board's Todo
  column and the sidebar's Todo group. Starting an issue creates a linked
  workspace.
- **Task**: not a separate object, so avoid it as a label. The board's former
  **New Task** button is **New workspace**; `PeriodicTask` in code is a
  scheduled agent.

## Navigation and first run

The project menu in the header lists projects and includes **Create project**
and **Manage projects**. Switching projects keeps the current Board, Agents or
Reviews section, including the event-agent view. Menu links support opening a
project in another tab. The project name opens its board; the following
breadcrumb identifies the section.

The home page restores the saved project only while it appears in the active
project list; otherwise it opens the first active project. A missing project
provides **Go to projects** to choose another repository.

With no projects, onboarding uses the full page without an empty sidebar.
Desktop onboarding starts with **Local Path**; the browser starts with **GitHub
URL**. Both sources remain available.

## Phone navigation

Every page uses two header rows on phones: the sidebar menu and path or page
title first, then status and action controls. Workspace headers put project and
family navigation beside the workspace name in the first row, keeping the
content height stable between pages. See the
[shared header layout](architecture/workspace-state.md) for the layout contract.

On the Kanban board, Search and **New workspace** live in a toolbar in the main
pane, with visible labels and room for touch targets. In narrow message
composers, Options and Usage keep their icons while hiding their labels and
percentage; usage details remain available in the popover.

On narrow Agents panels, the agent list and editor share one vertical scroll
surface. Selecting an agent brings its editor into view; wide panels retain
independent list and editor scrolling.

## Historical progression model

> **Historical workspace progression model.** The Ratchet fixer workflow and
> related PR state described here have been replaced by PR monitoring. Use
> [workspace state](architecture/workspace-state.md) and
> [PR monitoring](architecture/pull-requests.md) for current behavior. The
> sections below describe earlier behavior and may refer to renamed or removed
> APIs and tests.

This document defines the workspace lifecycle, Kanban ownership, and PR Ratchet
model.

Goals:

- one clear mental model for workspace progression;
- one canonical derivation for `WORKING`, `WAITING`, and `DONE`;
- distinct signals for live session activity and background PR/Ratchet activity;
- explicit handling for human-attention states, exhausted retries, and archive
  behavior.

## Terms

- `workspace.status`: provisioning lifecycle (`NEW`, `PROVISIONING`, `READY`,
  `FAILED`, `ARCHIVING`, `ARCHIVED`).
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
  - `NOT_FETCHED`: `prCiStatus` is `UNKNOWN` — checks have not been read for
    this PR yet;
  - `CHECKS_PENDING`, `CHECKS_FAILED`, `CHECKS_PASSED` for `prCiStatus`
    `PENDING`/`FAILURE`/`SUCCESS`, or `CHECKS_UNKNOWN` for any other value;
  - `NO_CHECKS` is a member of the type but is not currently produced by the
    derivation — it used to mean "an old enough snapshot reports no checks",
    gated by a wall-clock grace period that distinguished it from `NOT_FETCHED`.
    That grace period was removed, so `UNKNOWN` now always reads as
    `NOT_FETCHED`.
- `isWorking`: live agent-session activity only. PR/CI/Ratchet progress does not
  set this field; that background ownership is represented by `flowPhase`,
  `ciObservation`, `hasMergeConflict`, and `dispatchStalled` when deriving
  `statusReason` (and, through it, the Kanban column).
- `statusReason`: derived user-facing reason such as `Needs permission`,
  `Waiting for CI`, `No session started`, or `Fixing review comments`.

## Sources of Truth

PR/Ratchet flow is derived in:

- `src/backend/services/workspace/service/state/flow-state.ts`

The user-facing `statusReason` (next-action ownership) is derived in:

- `src/shared/workspace-status-reason.ts`

The Kanban column is a pure projection of `statusReason.code`, not an
independent derivation, in:

- `src/shared/kanban-column-projection.ts`

The derived outputs are assembled and projected by:

- `src/backend/lib/workspace-derived-state.ts`;
- `src/backend/services/workspace/service/query/workspace-query.service.ts`;
- `src/backend/trpc/workspace.trpc.ts`.

The service-level `isWorking` output remains session-only even when the
resulting Kanban column is `WORKING` because CI or Ratchet automation owns the
next action.

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
`src/backend/services/ratchet/service/ratchet.service.ts`. Its monitor loop uses
the shared `SERVICE_INTERVAL_MS.ratchetPoll` interval of two minutes. It
evaluates `READY`, Ratchet-enabled workspaces with PRs, refreshes their Ratchet
state from live GitHub data, and dispatches fixer sessions when the decision
policy requires one.

The PR scheduler in `src/backend/orchestration/scheduler.service.ts` uses
`SERVICE_INTERVAL_MS.schedulerPrSync` to sync stale PR snapshots and discover
new PRs every three minutes. Page-load `syncPRStatus` calls and these periodic
syncs converge cached PR state; see
[terminal PR polling](architecture/pull-requests.md#terminal-pr-polling) for
which refreshes are forced.

Enabling Ratchet through `workspace.toggleRatcheting` also starts a background
`ratchetService.checkWorkspaceById(...)` evaluation so the workspace does not
have to wait for the next two-minute monitor cycle.

## Kanban as Next-Action Ownership

The column is no longer derived independently from the label.
`deriveWorkspaceStatusReason` (`src/shared/workspace-status-reason.ts`) computes
a single `WorkspaceStatusReason` — the `code` the label renders — and
`kanbanColumnForStatusReason` (`src/shared/kanban-column-projection.ts`) looks
the column up from that same `code` through
`KANBAN_COLUMN_BY_STATUS_REASON_CODE`, a total
`Record<WorkspaceStatusReasonCode, KanbanColumn | null>`. Because the map is
total, a new reason code with no column mapping is a compile error rather than a
silent `WAITING`.

`deriveWorkspaceStatusReason` accepts:

- `lifecycle`, `hasHadSessions`;
- `isWorking`, `isSessionStarting`;
- `pendingRequestType`, `hasSessionRuntimeError`;
- `flowPhase`, `ciObservation`, `prState`, `prCiStatus`, `ratchetState`;
- `ratchetEnabled`, `hasMergeConflict`, `dispatchStalled`;
- `mode`, `autoIterationStatus`.

`runScriptStatus` is not an input — the dev server has no status-reason code —
and `ratchetDispatchOutcome`/`ratchetDispatchRetryCount` are not read directly;
`dispatchStalled` subsumes the retry-exhaustion check below.

The reason is the first non-null result of these functions, tried in order:

| Order | Function                     | Produces                                                                                                                                     |
| ----- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `deriveArchiveReason`        | `ARCHIVING`/`ARCHIVED` (column `null`, off the board)                                                                                        |
| 2     | `deriveTerminalPrReason`     | `MERGED` (`DONE`) or `PR_CLOSED` (`DONE`)                                                                                                    |
| 3     | `deriveBlockingReason`       | `NEEDS_PERMISSION`/`NEEDS_PLAN_APPROVAL`/`NEEDS_ANSWER`/`SESSION_ERROR` (`WAITING`)                                                          |
| 4     | `deriveLifecycleReason`      | `SETTING_UP` (`WORKING`) or `SETUP_FAILED` (`WAITING`)                                                                                       |
| 5     | `deriveActiveReason`         | `AGENT_WORKING`/`STARTING_SESSION`/`AUTO_ITERATING` (`WORKING`)                                                                              |
| 6     | `deriveRatchetTroubleReason` | `RATCHET_STALLED`/`FIXING_MERGE_CONFLICT`/`MERGE_CONFLICT`                                                                                   |
| 7     | `derivePrFlowReason`         | `WAITING_FOR_CI`/`FIXING_CI_FAILURES`/`FIXING_REVIEW_COMMENTS`/`CHECKING_PR` (`WORKING`), or `READY_TO_MERGE`/`READY_FOR_REVIEW` (`WAITING`) |
| 8     | `deriveIdleReason`           | `NO_SESSION_STARTED`/`READY_FOR_NEXT_PROMPT` (`WAITING`, exhaustive fallback)                                                                |

Terminal PR state (2) deliberately outranks a pending request or session error
(3): a merged or closed PR is reported as such even when a permission request or
runtime error would otherwise win. That precedence is preserved from the
derivation this one replaced. Archive state (1) outranks everything, including a
terminal PR — an archiving workspace with a merged PR still reads as
`ARCHIVING`, not `MERGED`.

`deriveRatchetTroubleReason` (6) is where the old per-read exhausted-retry rule
now lives, as persisted state rather than a recomputation: `dispatchStalled` on
the PR's `WorkspacePRRatchet` row is set when a settled dispatch achieved
nothing for an unchanged snapshot key, or when a `DIED` fixer exhausts its
retries, and cleared by `resetSettledDispatch` (a PR aggregate change) or
`disable`. While it is set, Ratchet-enabled workspaces report `RATCHET_STALLED`
(`WAITING`) instead of whatever the CI/review flow would otherwise select. A
live merge conflict reports through the same function ahead of the flow check:
`FIXING_MERGE_CONFLICT` (`WORKING`) while Ratchet is enabled and working it,
`MERGE_CONFLICT` (`WAITING`) when Ratchet cannot act on its own.

Archiving and archived workspaces derive a `null` column, which keeps them off
the active board. The column is never persisted: `kanbanColumnForStatusReason`
runs on every read against the same `statusReason` the label uses, so the board,
the sidebar, the snapshot stream, and the child-workspace panel cannot disagree
about it — the label and the column used to be derived independently and could.

There is also one project-scoped read behind it. `workspace.listForProject`
returns every live workspace in a project with its derived state, and the board
and the sidebar select what they render from that single list — the board
dropping rows whose column is `null`. Column-wide actions use
`findWorkspaceIdsInKanbanColumn`, which derives the column rather than filtering
in SQL, because live session state is not in the database.

## Where the PR Cache Lives

Everything the app knows about a workspace's pull requests lives in a
`WorkspacePR` collection — one row per attached PR — rather than columns on
`Workspace`. Each row stores `url`, `number`, head/base branches, `state`,
`reviewState`, `ciStatus`, `hasMergeConflict`, `syncedAt`, `ciFailedAt`,
`ciLastNotifiedAt`, and the `reviewLast*` cursors. `workspace-pr.accessor.ts` is
the only writer.

The split says something the old layout hid: this is a cache, not a source of
truth. Every field is a copy of GitHub state or a cursor into it — except
`ciLastNotifiedAt`, application-owned bookkeeping for CI-failure notifications —
and losing the whole row costs one refresh. Sitting beside the workspace's own
durable identity, that was invisible.

PR discovery scheduling lives on a separate per-workspace `WorkspacePRDiscovery`
row, created with the workspace, because discovery claims its backoff before any
PR exists; `WorkspacePR` rows are added when PRs attach and tombstoned (via
`detachedAt`) on detach.

Reads flatten the row back onto the workspace under the old `pr*` names, so
derived state, the snapshot stream and the client see the shape they always did
for the active PR; the snapshot wire also carries the `prs` collection and an
aggregate `prSummary`. `syncedAt` is the one rename: on `Workspace` it was
`prUpdatedAt`, which read as GitHub's PR `updated_at` but always held the
caller's own observation time.

Two consequences worth knowing:

- **Discovery polling no longer counts as workspace activity.** Claiming a
  discovery attempt used to write a `Workspace` column, which bumped `updatedAt`
  and floated PR-less workspaces to the top of any `updatedAt`-ordered list on
  every poll. The claim now writes only its own row (`WorkspacePRDiscovery`).
  The compare-and-swap is unaffected — the retry count still moves — and the
  guards on `status`, `branchName` and `updatedAt` are relation filters.
- **Three composite indexes are gone.** `[status, prUrl]`,
  `[status, prUrl, prDiscoveryNextCheckAt]` and `[status, prUpdatedAt]` cannot
  span tables. The PR-sync and PR-discovery queries are now joins, filtering
  `status` on `Workspace` and the rest against indexes on `WorkspacePR` and
  `WorkspacePRDiscovery`.

## Where Ratchet State Lives

Nowhere: `ratchetState` is not stored. It is a pure function of the PR
observation, computed by `deriveRatchetState`
(`src/shared/core/ratchet-state.ts`) from `ratchetEnabled` plus four
`WorkspacePR` columns — `state`, `ciStatus`, `reviewState` and
`hasMergeConflict`. The projection happens at the accessor boundary that already
flattens the side tables, so every read that used to get a column gets a
computed value under the same name, and no write can put the two out of step.

What that replaced:

- **A 127-line transition table** (`ratchet-state-machine.ts`) that permitted
  all 49 of its 49 state pairs. `isValidRatchetTransition` could not return
  false and `assertValidRatchetTransition` could not throw. Its own header
  called it "a tripwire for future refactors rather than restricting today's
  graph"; it was documentation, and it is gone along with its 89-line test.
- **A compare-and-swap on `state`**, which existed to keep the `fromState` on
  `RATCHET_STATE_CHANGED` accurate. No consumer of that event reads `fromState`
  or `toState` — the handler enqueues `prCiStatus` and asks for an authoritative
  re-projection. The CAS on `enabled` survives, because "was ratcheting disabled
  while this check ran" is a real question; the state half is gone, and with it
  the `superseded` branch in `finishRatchetCheck`.
- **Two settling writes.** Disabling a workspace, and `markPrClosed` with its
  three-attempt CAS retry loop, both existed to force `state` to `IDLE`. A
  disabled workspace and a closed PR both derive to `IDLE`, so the toggle and
  the PR sync are now the whole transition — and the window in which
  `ratchetState` disagreed with `ratchetEnabled` is closed by construction.

**One column was added, not just removed.** `WorkspacePR.hasMergeConflict`
(GitHub's `mergeStateStatus == DIRTY`) was observed on every ratchet fetch but
never persisted: the ratchet folded it into `RatchetState.MERGE_CONFLICT` and
stored that. So the trade is one derived enum column for one observed boolean.

The migration backfills it from `state = 'MERGE_CONFLICT'`, which under-reports:
a failing build outranked a conflict in the derivation, so a PR with both was
stored as `CI_FAILED` and migrates as clean. That is accepted rather than
patched. The dispatch snapshot key carries a conflict too (`|merge:conflict`)
but it records whenever the last fixer was dispatched, not the last observation,
so it cannot distinguish a live conflict from one resolved after its dispatch.
While CI is failing the derivation returns `CI_FAILED` and never reads the flag,
and a ratchet check that turns CI green writes the true flag in the same
statement — but the PR-sync poller writes `ciStatus` without touching
`hasMergeConflict`, so if it observed green first the derivation would report
`READY` for a PR GitHub still calls `DIRTY`.

So the migration nulls `lastCheckedAt` on exactly those rows — open PRs whose
ratchet state was `CI_FAILED`, the only state that could mask a conflict. The
ratchet poll orders by `lastCheckedAt` ascending and SQLite sorts NULLs first,
so they are re-observed on the first cycle after the migration and the flag is
established from a live fetch rather than guessed at. Over-reporting would be
visible — a spurious conflict badge, and a conflict fixer dispatched against a
clean PR — which is why no value is inferred.

**The ratchet check persists the whole observation, not just CI.** This is the
part that makes the projection sound: `ratchetState` is read from the cache, so
anything a check saw and kept to itself is something no later read can derive.
That used not to matter — the check wrote its conclusion straight into a `state`
column, so a merge or a new changes-requested review reached the app even while
the cache lagged the PR-sync poller. `recordPrObservation` now writes `prState`,
`prReviewState`, `prCiStatus` and `hasMergeConflict` together. The github
capsule's PR observation service folds draft status and review decisions into
`observation.prState`, which `acceptMonitoredObservation` persists to
`WorkspacePR.state`. The write is guarded on the PR identity the observation was
fetched for: the aggregate compare-and-swap reads its guard inside the write
transaction, so it catches a racing write but not a workspace re-pointed at a
new PR while the check was off fetching — and a stale `MERGED` stamped onto a
fresh PR would drop it out of the ratchet poll set. The guard keys on the PR
URL, with the number checked only when the cache has populated one — so a
re-point that swaps the URL is caught even if the new number is still unknown,
and even if a failed re-point left the old number cached. A null cached number
is still treated as "not known yet" for the number check, since discovery
attaches a url without a number; the URL check still applies.

`recordPrObservation` also publishes `PR_SNAPSHOT_UPDATED` for every applied
write, the same event the PR-sync poller publishes — otherwise a merge the
ratchet saw first would reach the database and stop there, leaving the client on
`OPEN` and the linked Linear issue uncompleted until the poller came round.
`PR_DISPATCH_INVALIDATED` is gone: it had one emitter and one handler and fired
only when a settled dispatch was reset, which is now carried as
`ratchetDispatchChanged` on the snapshot event. The conflict flag also joins the
aggregate change detector and its compare-and-swap guard, so a conflict
appearing or clearing invalidates a settled dispatch like any other aggregate
field and the two writers cannot race.

**Behaviour changes worth knowing:**

- A PR snapshot update now always triggers an authoritative ratchet projection,
  where it used to do so only when the dispatch record moved. That is what stops
  a snapshot showing `prState: MERGED` next to a `ratchetState` left over from
  the previous ratchet poll.
- The ratchet poll set reads both closed and merged off `WorkspacePR.state`. It
  used to ask two tables — `pr.state != CLOSED` and `ratchet.state != MERGED` —
  for the same fact.

What is shared across PRs lives on `WorkspaceRatchet`: the workspace toggle
(`enabled`), the check time, and one active fixer slot (`activePrId`,
`activeSessionId`). The per-PR dispatch tuple — snapshot key, outcome, retry
count, `dispatchStalled` — lives on `WorkspacePRRatchet` rows, one per attached
PR. `workspace-ratchet.accessor.ts` writes the shared row and
`workspace-pr-ratchet.accessor.ts` the per-PR rows, both enforced by the
owned-side-table rule in `check-single-writer`. `enabled` stays next to the
active slot because every conditional ratchet write guards on it in the same
statement it writes.

Reads flatten the shared row back onto the workspace under the old `ratchet*`
names (`enabled`, `lastCheckedAt`, `activeSessionId`, `activePrId`). When
exactly one PR is attached, its per-PR dispatch fields flatten under the
`ratchetDispatch*` names; with multiple PRs, `prSummary` supplies aggregate
state rather than projecting the active fixer's dispatch fields, so derived
state, the snapshot stream and the client see the shape they always did.
`dispatchSnapshotKey` is the one rename: on `Workspace` it was
`ratchetLastCiRunId`, whose schema comment described it as a misnomer kept to
avoid a migration. It holds the full dispatch snapshot key — PR number, CI
signature, review activity, merge conflict — not a CI run id.

`WorkspaceRatchet` is created with every workspace, so no workspace can exist
that its row-guarded writes would silently skip; `WorkspacePRRatchet` is created
with each `WorkspacePR`. Backups export the per-PR collection and dispatch
histories at `schemaVersion: 5`; version 4 imports normalize into that shape.

## Cached and Live State Propagation

Persisted snapshot entries include `ratchetDispatchStalled`, so reconciliation
and snapshot-derived Kanban state read the same exhausted-dispatch conclusion as
full workspace queries rather than recomputing it. `ratchetDispatchOutcome` and
`ratchetDispatchRetryCount` are also on the snapshot entry, but only for the
detail view's dispatch history — the column projection reads `dispatchStalled`
directly and does not derive exhaustion from them.

Ratchet dispatch changes publish `ratchet_dispatch_changed` as an invalidation
after successful dispatch-record mutations. PR resets and Ratchet toggles use
the same invalidation model. The event collector serializes and coalesces those
invalidations per workspace, re-reads the authoritative Ratchet fields from the
database, and reruns the projection when another mutation lands during a read.
This prevents a delayed older callback from overwriting a newer dispatch or
reset. Direct Ratchet CI observations use the same aggregate-change reset and
full dispatch-tuple compare-and-swap as scheduled PR snapshots, so `FAILURE` to
`PENDING` clears exhausted ownership without overwriting a concurrent `RUNNING`
fixer. Fresh `prCiStatus` observations still travel directly on Ratchet state
events, while `ratchetState` is always re-read authoritatively — which, now that
it is derived, means recomputed from the PR row rather than re-read from a
column. Projection reads retry transient failures with bounded backoff and are
cancelled on collector stop or reconfiguration.

Durable cached-column refreshes serialize their complete read/derive/write
operation per workspace and retry transient failures. Their final write is
conditional on the lifecycle and ownership tuple that was read; a lifecycle or
Ratchet race causes a fresh derivation instead of a stale write, preserving
archived columns. Event-collector timestamps are strictly monotonic so later
same-millisecond updates cannot be rejected as stale by the snapshot store. The
collector owns and removes every domain listener and cancels pending
projection/coalescer work on stop or reconfiguration. Session activity remains a
live overlay and is the only source of the public `isWorking` flag.

## Ratchet Animation

The Ratchet button animates only when `flowPhase === 'CI_WAIT'` and Ratchet is
enabled. Push interceptors and other utility animation triggers are not part of
the current model.

## Invariants

1. Archive state is handled before every visible Kanban column, including a
   terminal PR: an archiving workspace with a merged PR still reads as
   `ARCHIVING`, not `MERGED`.
2. Terminal PR state wins over human-attention and automation-owned states.
3. Human-attention state (a pending request or a session runtime error) wins
   over active session, Ratchet-stalled, and flow state.
   Ratchet-stalled/merge-conflict state is checked after active session and
   auto-iteration ownership but before PR/CI flow state, so a live session still
   reads as `AGENT_WORKING` even while `dispatchStalled` is set.
4. `isWorking` reports session activity only; Kanban `WORKING` may instead be
   owned by setup, CI, or Ratchet automation.
5. `CIStatus.UNKNOWN` maps directly to the `NOT_FETCHED` `ciObservation`. The
   wall-clock grace period that used to precede `NO_CHECKS` was removed.
6. Enabling Ratchet triggers an immediate background evaluation.
7. The Kanban column is a total-map lookup on `statusReason.code`
   (`KANBAN_COLUMN_BY_STATUS_REASON_CODE`); it cannot diverge from the label
   because both come from the same `statusReason`, and an unmapped reason code
   is a compile error.

## Testing Coverage

Key tests are located at:

- PR/Ratchet flow derivation:
  `src/backend/services/workspace/service/state/flow-state.test.ts`;
- next-action ownership (`statusReason`):
  `src/shared/workspace-status-reason.test.ts`;
- the Kanban column projection, including a check that every status-reason code
  resolves: `src/shared/kanban-column-projection.test.ts`;
- lifecycle transitions and lifecycle-driven cache updates:
  `src/backend/services/workspace/service/lifecycle/state-machine.service.test.ts`;
- query projections:
  `src/backend/services/workspace/service/query/workspace-query.service.test.ts`;
- Ratchet behavior, dispatch retries, and disable semantics:
  `src/backend/services/ratchet/service/ratchet.service.test.ts`;
- Ratchet visual-state helpers:
  `src/client/features/workspace/ratchet-state.test.ts`;
- snapshot propagation and reconciliation:
  `src/backend/services/workspace/service/snapshot/workspace-snapshot-store.service.test.ts`
  and `src/backend/orchestration/snapshot-reconciliation.orchestrator.test.ts`;
- live event propagation:
  `src/backend/orchestration/event-collector.orchestrator.test.ts`.

## File change markers

The **Changes** tab shows **M** for modified files, **A** for added files, **D**
for deleted files, and **New** for untracked files (Git's `??` status). New
files exist on disk but have not been staged with `git add`; the marker is not
an error. Git enumerates these files using the repository's ignore rules, so
ignored artifacts inside new directories stay out of Changes.
