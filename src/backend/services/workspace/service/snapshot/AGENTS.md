# Workspace snapshot store

The in-memory, per-process store of one entry per live workspace that the
`/snapshots` stream serves to the board, sidebar and detail views. The
[workspace capsule guide](../../AGENTS.md) covers the capsule and the name and
branch freshness rules. Bare file names below are in this directory; paths that
start with `src/` are from the repository root.

## Owns, and does not own

This directory owns how updates merge into an entry: one clock per field group,
removal tombstones, PR revision fences, which fields have been accepted from an
update, the complete-summary claim, derived state (`isWorking`, `statusReason`,
`kanbanColumn`, sidebar status, selected PR) and `waitingSince`. It does not
own:

- Which raw fields exist, their group, hydration requirement and drift policy:
  `src/shared/workspace-projection-fields.ts`.
- The derivations it calls: `src/backend/lib/workspace-derived-state.ts`,
  `src/shared/workspace-status-reason.ts` and
  `src/shared/kanban-column-projection.ts`.
- Who writes: the event collector and periodic reconciliation in
  `src/backend/orchestration/snapshots/` (its
  [guide](../../../../orchestration/snapshots/AGENTS.md)), and accepted renames
  and PR follow-ups in `src/backend/orchestration/workspace-lifecycle/`.
- Streaming entries to clients:
  `src/backend/routers/websocket/snapshots.handler.ts`.

## Public surface

`workspaceSnapshotStore` and `WorkspaceSnapshotStore`, through the capsule
barrel: `upsert`, `seedCreated` for committed creations, `publishAcceptedName`
and `publishAcceptedBranch`, `remove`, the readers, and the `snapshot_changed`
and `snapshot_removed` events. `configure` injects the derivation functions
before the first upsert.

## Invariants

- A field group accepts an update only when its timestamp is strictly newer than
  the group's last accepted one, so an equal or older observation changes
  nothing; PR and ratchet facts with a newer PR revision are ordered by that
  revision instead, and names and branches have their own fences (capsule
  guide). `workspace-snapshot-store.service.test.ts`,
  `workspace-snapshot-store.prs.test.ts`.
- An update no newer than a workspace's removal is ignored, so a read that began
  before an archive cannot bring the entry back.
  `workspace-snapshot-store.service.test.ts`.
- A creation seed never replaces an existing entry, passes a removal tombstone
  or seeds an archiving or archived workspace.
  `src/test-utils/workspace-creation-publication.integration.test.ts`.
- An entry claims `summaryVersion: 1` only after every required field was
  accepted from an update, so defaults and values rejected by a clock never
  complete it. `workspace-snapshot-field-contract.test.ts`,
  `workspace-snapshot-store.summary.test.ts`.
- `waitingSince` is set only when an accepted update moves an existing entry
  into Waiting and is cleared when it leaves, so an entry first seen in Waiting
  has an unknown start. `workspace-waiting-since.test.ts`.
- The store imports no service capsule except the pure read-state helper.
  `workspace-snapshot-store.service.test.ts`,
  `src/backend/services/workspace/service/state/workspace-read-state.boundary.test.ts`.

## Map

- `workspace-snapshot-store.service.ts`: the store. Group merging follows the
  field inventory, then derived state, `waitingSince` and summary completeness
  are recomputed before an entry is published.
- `branch-freshness.ts`: private branch provenance, separate from the group
  clocks.
- `pr-projection-freshness.ts`: fences PR facts by association revision and
  `prCollectionRevision`, independent of publication clocks.

## Decisions

- [The PR collection revision counts detached rows](../../../../../../docs/decisions/2026-11-13-pr-collection-revision-counts-detached-rows.md)
