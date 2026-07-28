# Kanban Column Projection Design

## Goal

Make a workspace's Kanban column a projection of its status reason, so that the column a card sits in and the label the card shows can never contradict each other, and so that WAITING means exactly one thing: a human owns the next action.

## Problem

Two derivations compute overlapping conclusions from overlapping inputs.

`deriveWorkspaceStatusReason` (`src/shared/workspace-status-reason.ts`) produces one of twenty codes, each carrying a `needsUser` flag. It is what the card label renders. `computeKanbanColumn` (`src/backend/services/workspace/service/state/kanban-state.ts`) independently produces one of three columns from a narrower input set. `assembleWorkspaceDerivedState` (`src/backend/lib/workspace-derived-state.ts`) calls both side by side, so nothing forces them to agree.

They were unified separately and never joined: `#1671` unified the status reason, `#1978` and `#2025` reworked the column. Today they disagree in three places.

| Reason code | `needsUser` | Column today | Correct |
|---|---|---|---|
| `DEV_SERVER_RUNNING` | false | WAITING | column right, code should not exist |
| `READY_TO_MERGE`, `READY_FOR_REVIEW` | false | WAITING | column right, `needsUser` wrong |
| `CHECKING_PR` on a conflicted PR | false | WORKING | column right, label wrong |

Underneath the disagreements is a structural defect: WAITING is the fallback bucket. `computeKanbanColumn` returns it for "all remaining nonterminal workspaces", so every gap in the WORKING predicate silently becomes a WAITING card. The column that should mean "truly idle, waiting on me" is the one that absorbs every state nobody classified.

## Evidence

Measured against the live database (17 non-archived workspaces):

- All 17 are at lifecycle `READY`. 14 have merged PRs, 3 have no PR.
- 0 auto-iteration workspaces, 0 merge conflicts, 0 stalled ratchet dispatches on live PRs.
- 0 live workspaces with `ciStatus = UNKNOWN`; all 14 `UNKNOWN` rows are `MERGED`/`CLOSED` and ~111 days stale.
- 9 live workspaces carry a GitHub issue link.

Because every live workspace is `READY`, the column for essentially the whole board is decided by a single axis: lifecycle `READY` plus whether a session reads as working. That axis is where the user-visible defect lives, and it is what this design prioritises. Several other defects found during analysis are real code paths that nothing currently walks; they are fixed here because the projection makes them a few lines each, not because they explain the symptom.

## Architecture

### The projection

A new shared module owns a total map from status reason code to column:

```ts
export const KANBAN_COLUMN_BY_STATUS_REASON_CODE: Record<
  WorkspaceStatusReasonCode,
  KanbanColumn | null
>
```

Typing it as a `Record` over the code union makes an unmapped code a compile error, which is the property that keeps the two derivations joined for good.

`computeKanbanColumn` reduces to a lookup on `statusReason.code`. `assembleWorkspaceDerivedState` computes the status reason first and derives the column from it, so the column cannot be reached by any other path. Because the map is a pure function over two shared types, it lives in `src/shared/` and is imported directly rather than injected: `WorkspaceDerivedStateFns` loses its `computeKanbanColumn` member (`deriveSidebarStatus` stays injected, unchanged) and `src/backend/services/workspace/service/state/kanban-state.ts` is deleted.

The column assignment:

| Column | Codes |
|---|---|
| WORKING | `SETTING_UP`, `STARTING_SESSION`, `AGENT_WORKING`, `AUTO_ITERATING`, `WAITING_FOR_CI`, `FIXING_CI_FAILURES`, `FIXING_REVIEW_COMMENTS`, `FIXING_MERGE_CONFLICT`, `CHECKING_PR` |
| WAITING | `NEEDS_PERMISSION`, `NEEDS_PLAN_APPROVAL`, `NEEDS_ANSWER`, `SESSION_ERROR`, `SETUP_FAILED`, `MERGE_CONFLICT`, `RATCHET_STALLED`, `READY_TO_MERGE`, `READY_FOR_REVIEW`, `NO_SESSION_STARTED`, `READY_FOR_NEXT_PROMPT` |
| DONE | `MERGED`, `PR_CLOSED` |
| null | `ARCHIVING`, `ARCHIVED` |

WAITING is now positively asserted rather than inherited. A future code with no obvious home defaults to WORKING by deliberate convention: an unclassified workspace should read as "something is happening" and be corrected, rather than quietly polluting the idle column.

### `STARTING_SESSION`

`isSessionSummaryWorking` (`src/shared/session-runtime.ts`) counts a session as working only at `runtimePhase: 'running'` or `activity: 'WORKING'`. The phases `'loading'` and `'starting'` are neither, so a session that is demonstrably spawning reads as not-working.

Workspace init marks the workspace `READY` (`workspace-init.orchestrator.ts:805`) while `startDefaultAgentSession` is still in flight (line 779). Every launch therefore passes through lifecycle `READY` with a starting-but-not-running session, which today falls through to the WAITING fallback. The card visibly flashes WORKING → WAITING → WORKING.

A new predicate `hasStartingSessionSummary(summaries)` in `src/shared/session-runtime.ts` returns true for `runtimePhase` of `'starting'` or `'loading'`. `WorkspaceStatusReasonInput` gains `isSessionStarting`, and `deriveActiveReason` returns `STARTING_SESSION` ("Starting session", tone `working`, `needsUser: false`) immediately after its `isWorking` check.

Ordering is deliberate. Blocking reasons still precede active ones, so a permission request on a starting session remains WAITING; lifecycle reasons still precede them, so `NEW`/`PROVISIONING` still reports `SETTING_UP`.

Both derivation call sites already have the summaries in hand and already call `findWorkspaceSessionRuntimeError` over them, so each gains one symmetrical predicate call: `workspace-query.service.ts` and `workspace-snapshot-store.service.ts`.

### Removing `DEV_SERVER_RUNNING`

Nothing reads this code. The Kanban card already renders an independent dev-server indicator keyed straight off `runScriptStatus` (`kanban-card.tsx:303-312`), so the status reason duplicates it — and worse, masks. `deriveActiveReason` runs before both `derivePrFlowReason` and `deriveIdleReason`, so starting a dev server on a green PR rewrites its label from "Ready to merge" to "Dev server running". Under the projection that would move the card as well.

The code is deleted and `runScriptStatus` is removed from `WorkspaceStatusReasonInput` entirely. A running dev server is a fact about a tool, not about who owns the next action, and the card's existing badge already conveys it.

### Merge conflict

The ratchet does dispatch a fixer for conflicts: `hasActionableFixTrigger` returns true on `hasMergeConflict` (`ratchet.service.ts:733-735`), and `ratchet.service.ts:617` bypasses the wait-for-terminal-CI gate when a conflict is present, so the dispatch happens ahead of CI. `shouldSkipCleanPR` likewise refuses to skip one. A conflicted PR with the ratchet enabled is genuinely being worked on.

Today both conflict cases land in the right column for the wrong reason, and both are mislabelled. With the ratchet on, the card says "Checking PR" while a fixer runs. With the ratchet off, `deriveRatchetState` returns `IDLE`, the flow reaches `READY`, and the card says "Ready to merge" about a PR that cannot be merged.

Two codes replace that, inserted into `derivePrFlowReason` ahead of the `READY` branches:

- `FIXING_MERGE_CONFLICT` — ratchet enabled and conflicted. Detected via `ratchetState === MERGE_CONFLICT`, which already implies both conditions. WORKING, `needsUser: false`.
- `MERGE_CONFLICT` — ratchet disabled and conflicted. Detected via `hasMergeConflict && !ratchetEnabled`, so `WorkspaceStatusReasonInput` gains `hasMergeConflict`. WAITING, `needsUser: true`.

One asymmetry is left alone deliberately. `deriveRatchetState` ranks `CI_FAILED` above `MERGE_CONFLICT`, while the ratchet's dispatcher ranks conflict above CI. A conflicted PR with failing CI therefore reports `FIXING_CI_FAILURES` while the fixer is in fact working the conflict. Both are WORKING and both are honest about the agent being engaged, so reconciling the two orderings is left out of this change.

### `RATCHET_STALLED`

A fixer that settles `COMPLETED` without changing the PR state is not re-dispatched, because the ratchet re-dispatches only on a changed snapshot key (`ratchet.service.ts:815`). Nothing is running, but the flow state still reports working, so the card stays in WORKING indefinitely. Only the `DIED`-with-exhausted-retries path currently escapes.

This matters most for conflicts. "The agent will pick it up" is true, and without a stall signal it stays permanently true-looking even when the agent picked it up and failed.

The snapshot key cannot be recomputed from cached fields — it hashes `statusCheckRollup` detail that `WorkspacePR` does not store. So the ratchet persists its own conclusion rather than having it re-derived: a `dispatchStalled` boolean on `WorkspaceRatchet`, cleared where dispatch state is already reset on a changed observation (`resetSettledDispatch`) and on `disable`, and set at the two points where a check concludes it will take no further action until the PR changes:

- the unchanged-key gate in `decideRatchetAction` ("PR state unchanged since last ratchet dispatch"), reached only after an actionable fix trigger was confirmed and the `DIED` and active-session paths have already returned — so reaching it means a settled dispatch achieved nothing;
- the exhausted-retries branch of `decideDiedFixerRetry`.

Folding both into one flag is what keeps this from regressing. Today's `computeKanbanColumn` has its own `retriesExhausted` rule (`dispatchOutcome === 'DIED'` and retries at the threshold) that sends a workspace to WAITING. The projection removes that rule along with the rest of the column's independent inputs, so `dispatchStalled` has to cover the `DIED`-exhausted case too or the behavior is lost. With both covered, `ratchetDispatchOutcome` and `ratchetDispatchRetryCount` drop out of derivation entirely — they stay on the wire for the detail view, but `WorkspaceDerivedStateInput` replaces both with `dispatchStalled`.

`RATCHET_STALLED` ("Auto-fix stalled", tone `attention`, `needsUser: true`) precedes the `RATCHET_FIXING` branches in `derivePrFlowReason`.

### `AUTO_ITERATING`

`mode` and `autoIterationStatus` are inputs to neither derivation, so a running auto-iteration loop between sessions falls to WAITING. Auto-iteration workspaces also skip the default session start at init (`workspace-init.orchestrator.ts:773-785`), so they land in WAITING immediately after provisioning.

`deriveWorkspaceStatusReason` gains `mode` and `autoIterationStatus`, and `deriveActiveReason` returns `AUTO_ITERATING` ("Auto-iterating", tone `working`, `needsUser: false`) when the mode is `AUTO_ITERATION` and the status is `RUNNING`. It is checked after `isWorking` and after `STARTING_SESSION`, so a loop with a live session still reports the more specific `AGENT_WORKING`; `AUTO_ITERATING` is what covers the gaps between iterations.

These two fields are currently absent from the snapshot wire — `snapshot-to-workspace.ts` lists them under `mutationOnlyFieldDefaults`. They move onto the wire in the `workspace` field group. This contradicts the current note in `AGENTS.md` that the auto-iteration group is deliberately mutation-only; that note is amended, because the alternative is a derivation the snapshot store cannot reproduce, which is precisely the drift this design removes.

### Snapshot wire additions

Three fields join `WorkspaceSnapshotEntry`, its Zod schema, and the store's field-group mappings:

- `hasMergeConflict` in the `pr` group
- `mode` and `autoIterationStatus` in the `workspace` group

`dispatchStalled` joins the existing `ratchet` group alongside `ratchetDispatchOutcome` and `ratchetDispatchRetryCount`. All four are removed from `mutationOnlyFieldDefaults` where applicable.

### Todo/board duplication

Clicking Start creates the workspace and fires an un-awaited `utils.workspace.listForProject.invalidate()` (`issue-launch-sheet.tsx:169`). The WebSocket snapshot for the new workspace usually wins that race and inserts a card through `applySnapshotChangedMessage`. `projectSnapshotToWorkspace` fills unknown workspaces from `mutationOnlyFieldDefaults()`, which sets `githubIssueNumber` and `linearIssueId` to null — and those are the exact fields `filterIssuesForCurrentWorkspaceState` matches on. So the workspace appears on the board while its issue is still in Todo.

It is not always brief. `listForProject` uses `staleTime: Infinity` with `refetchOnWindowFocus: false`, so a workspace introduced by the snapshot stream rather than by a local mutation — a periodic task, a child spawn, another browser tab — keeps a null issue link until something forces a refetch.

The fix is at the introduction point, not on the issue-link fields: when a snapshot message introduces a workspace id the cache has not seen, invalidate `listForProject` for that project. This self-heals every mutation-only field rather than the two that happen to hurt today. Both `applySnapshotChangedMessage` and `applySnapshotFullMessage` can introduce unknown ids and both are covered.

Repeat invalidations while a refetch is in flight are guarded by a set of already-invalidated workspace ids, held in a hook-scoped `useRef` alongside the existing `previousPendingRequestsRef` and `baselineProjectsRef` (`use-project-snapshot-sync.ts:201`, `:208`). It follows `baselineProjectsRef`'s shape and lifetime exactly, so the guard is scoped per subscription rather than persisting process-wide.

A second, independent hole: `kanban-context.tsx` passes its board-filtered `workspaces` (those with a non-null column) as `workspaceIssueLinks`, so an archiving workspace drops out of the link set and its issue reappears in Todo mid-archive. The unfiltered `projectWorkspaces?.workspaces` is passed instead. The board keeps its own null-column filter for rendering.

### CI observation purity

`deriveWorkspaceCiObservation` calls `Date.now()` to split `CIStatus.UNKNOWN` into "not fetched yet" and "no checks configured" using a 90-second window from the last observation. Derived state that is not a pure function of stored facts makes snapshot recomputation non-idempotent: the same row yields different columns at different times, and the 60-second reconciliation re-emits the change.

The measured data does not support a schema change here — an empty-but-present rollup already maps to `SUCCESS` (`ci-status.ts:181-182`), and no live workspace holds `UNKNOWN`. So the grace window and its `Date.now()` call are simply deleted, and `UNKNOWN` maps to `NOT_FETCHED`.

This changes one behavior: a persistently unfetchable PR reads as CI_WAIT (WORKING) instead of decaying to `NO_CHECKS` (WAITING) after 90 seconds. "We have not looked yet" is the honest reading of `UNKNOWN`, and the PR sync poll resolves it. Splitting `UNKNOWN` into distinct stored facts is deferred until data justifies it.

## Testing

The projection is guarded two ways: the `Record` type makes an unmapped code a compile error, and a runtime test iterates `WORKSPACE_STATUS_REASON_CODES` asserting every code resolves. `kanban-state.test.ts` is rewritten against the map.

`workspace-status-reason` tests cover each new code and its precedence: a starting session yields `STARTING_SESSION` but a pending permission on that same session still yields `NEEDS_PERMISSION`; `NEW`/`PROVISIONING` still yields `SETTING_UP`; a conflict yields `FIXING_MERGE_CONFLICT` with the ratchet on and `MERGE_CONFLICT` with it off; a stalled dispatch outranks `FIXING_CI_FAILURES`; `READY_TO_MERGE` and `READY_FOR_REVIEW` report `needsUser: true`; `runScriptStatus` no longer influences the result.

Snapshot store tests cover the four new wire fields round-tripping through the field groups and driving the derived column.

Client tests cover the invalidation: a `snapshot_changed` for an unknown workspace id triggers exactly one `listForProject` invalidation, a known id triggers none, and an archiving workspace still suppresses its issue from Todo.

Ratchet tests cover `dispatchStalled` being set when a check declines to re-dispatch an unchanged `COMPLETED` dispatch, and cleared on a changed observation and on a new dispatch.

`pnpm test`, `pnpm typecheck`, `pnpm check`, and `pnpm check:prisma-schema` guard the rest.

## Documentation

`AGENTS.md` needs three amendments:

- The Kanban model bullet: the column is a projection of the status reason, not an independent derivation.
- The auto-iteration bullet: `mode` and `autoIterationStatus` are now on the snapshot wire.
- The ratchet bullet: `dispatchStalled` joins the dispatch record.

The Kanban bullet also carries a claim that analysis did not support — that READY workspaces with no prior sessions are hidden from the board. `computeKanbanColumn` takes no `hasHadSessions` input and `listForProject` excludes only archiving and archived workspaces, so no such filter exists. That sentence is removed.

## Out of Scope

Adding a fourth column, changing what DONE means, and archiving cadence. A PR that is open, green, and ratchet-verified stays in WAITING, because a human owns the next action on it.

Splitting `CIStatus.UNKNOWN` into distinct stored facts, per the measurement above.
