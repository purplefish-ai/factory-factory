# Workspace Progression Model

This document defines the current workspace lifecycle and PR ratcheting model.

Goals:
- one clear mental model for workspace progression
- one derivation path for `WORKING` vs `WAITING` vs `DONE`
- explicit handling for edge cases and race conditions

## Terms

- `workspace.status`: lifecycle of workspace provisioning (`NEW`, `PROVISIONING`, `READY`, `FAILED`, `ARCHIVED`)
- `prState`: high-level PR state (`NONE`, `DRAFT`, `OPEN`, `CHANGES_REQUESTED`, `APPROVED`, `MERGED`, `CLOSED`)
- `prCiStatus`: CI snapshot (`UNKNOWN`, `PENDING`, `SUCCESS`, `FAILURE`)
- `ratchetEnabled`: workspace-level toggle for automated PR progression
- `ratchetState`: ratchet machine output (`IDLE`, `CI_RUNNING`, `CI_FAILED`, `REVIEW_PENDING`, `READY`, `MERGED`)
- `flowPhase`: derived workspace flow phase used by UI and kanban logic
- `ciObservation`: derived CI observation
  - `NOT_FETCHED`: PR exists but no CI snapshot has been fetched yet
  - `NO_CHECKS`: PR snapshot exists and reports no checks configured
  - `CHECKS_PENDING` / `CHECKS_FAILED` / `CHECKS_PASSED` / `CHECKS_UNKNOWN`

## Source Of Truth

Workspace flow is derived in one place:
- `src/backend/services/workspace-flow-state.service.ts`

```ts
type WorkspaceFlowPhase =
  | 'NO_PR'
  | 'CI_WAIT'
  | 'RATCHET_VERIFY'
  | 'RATCHET_FIXING'
  | 'READY'
  | 'MERGED';
```

Derived outputs:
- `isWorking`
- `shouldAnimateRatchetButton`
- `flowPhase`

These are consumed by:
- kanban derivation (`src/backend/services/kanban-state.service.ts`)
- sidebar and board projections (`src/backend/services/workspace-query.service.ts`)
- workspace detail API (`src/backend/trpc/workspace.trpc.ts`)

## Lifecycle State Machine

Workspace provisioning transitions (`src/backend/services/workspace-state-machine.service.ts`):

- `NEW -> PROVISIONING`
- `PROVISIONING -> READY | FAILED`
- `FAILED -> PROVISIONING | NEW | ARCHIVED`
- `READY -> ARCHIVED`

Invalid transitions throw `WorkspaceStateMachineError`.

## PR / Ratchet Progression

Ratchet monitor loop:
- polls every 60s (`src/backend/services/ratchet.service.ts`)
- loads all `READY` workspaces with open PR metadata
- determines current ratchet state from live GitHub PR details
- optionally triggers fixer sessions if `ratchetEnabled`

Immediate check on ratchet enable:
- `workspace.toggleRatcheting` now triggers `ratchetService.checkWorkspaceById(...)`
- this avoids waiting for the next 60s poll before entering verification/fix flow

## Working / Waiting / Done Rules

`computeKanbanColumn(...)` uses:
- `lifecycle`
- derived `isWorking`
- `prState`
- `hasHadSessions`

Current behavior:
- `WORKING`: provisioning states or derived working state
- `DONE`: merged PR and not working
- `WAITING`: idle ready workspace with prior sessions
- `null`: hidden `READY` workspaces with no prior sessions

Important: derived `isWorking` is:
- `sessionService.isAnySessionWorking(...) OR flowState.isWorking`

This keeps workspace position stable while ratchet is progressing even when no chat session is actively running.

## Ratchet Animation Rules

Ratchet button animation is now explicit:
- animate only when `flowPhase === 'CI_WAIT'` and `ratchetEnabled === true`

No push-based animation remains:
- `git-push` interceptor removed
- old utility-based animation triggers removed

## Invariants

These invariants should always hold:

1. If `workspace.status !== READY`, workspace lifecycle controls board placement.
2. If PR is active and `prCiStatus === PENDING`, workspace is `WORKING` regardless of ratchet toggle.
3. Ratchet button animation only occurs during CI wait with ratchet enabled.
4. If ratchet is enabled and PR is active after CI pending clears, workspace remains `WORKING` until ratchet reaches `READY` or `MERGED`.
5. Enabling ratchet should trigger immediate ratchet evaluation.
6. `CIStatus.UNKNOWN` must be interpreted through `ciObservation` (`NOT_FETCHED` vs `NO_CHECKS`).

## Edge Cases And Current Handling

1. Ratchet toggle changed during in-flight ratchet check.
- Risk: stale snapshot could trigger unwanted fixer action.
- Handling: `ratchet.service` now re-reads latest `ratchetEnabled` before executing actions.

2. GitHub fetch failure during ratchet check.
- Handling: action result is `ERROR`; previous ratchet state remains.
- Effect: workspace may temporarily stay in prior flow phase until next successful check.

3. `CIStatus.UNKNOWN` ambiguity at storage layer.
- DB still stores `UNKNOWN`, but flow derivation resolves it into explicit `ciObservation`:
  - `NOT_FETCHED` when `prUpdatedAt` is null
  - `NO_CHECKS` when `prUpdatedAt` is set
- This keeps UI/kanban logic deterministic while avoiding a DB enum migration.

4. PR URL present but PR metadata stale.
- Handling: sidebar/board projections use latest cached snapshot and ratchet state.
- Manual resync (`syncPRStatus`) and periodic polling converge state.

5. Archived workspaces.
- Handling: excluded from active list queries and retain cached pre-archive column.

## Testing Coverage

Key tests:
- flow-state derivation: `src/backend/services/workspace-flow-state.service.test.ts`
- kanban derivation: `src/backend/services/kanban-state.service.test.ts`
- ratchet behavior and disable semantics: `src/backend/services/ratchet.service.test.ts`
- ratchet visual state helpers: `src/components/workspace/ratchet-state.test.ts`

## Hardening Checklist (Recommended Next Steps)

1. Add integration tests around toggle-on/off races with mocked delayed GitHub responses.
2. Add contract tests asserting `flowPhase`, `ciObservation`, and `ratchetButtonAnimated` on all TRPC workspace endpoints.
3. Consider a future schema-level CI enum split (`NOT_FETCHED` / `NO_CHECKS`) if we want storage and derivation to match exactly.
4. Add a metrics dashboard for ratchet outcomes:
- state transition counts
- fixer trigger counts
- fetch failure counts
5. Add alerting for workspaces stuck in `RATCHET_VERIFY` beyond a threshold.
