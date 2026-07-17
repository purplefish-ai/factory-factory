# Value-Aware Snapshot Reconciliation Design

## Goal

Stop unchanged authoritative reconciliation passes from incrementing workspace snapshot versions or emitting `SNAPSHOT_CHANGED`, while preserving field-group timestamp ordering and existing removal tombstone safety.

## Root Cause

`WorkspaceSnapshotStore.mergeFieldGroups()` currently returns one boolean for two distinct outcomes: a newer timestamp was accepted and the corresponding values changed. `upsert()` therefore treats every accepted reconciliation timestamp as a public snapshot change, recomputes derived state, increments `version`, and emits an event even when all values are equal.

The reconciler cannot safely filter these calls before the store. Equal authoritative updates must still advance field-group timestamps so an older delayed event cannot overwrite the confirmed state.

## Design

The store will return an explicit `SnapshotUpsertResult` with `accepted`, `changed`, and `emitted` flags. Field-group merging will always advance timestamps for accepted groups, but it will assign only values that differ and report value changes separately from timestamp acceptance.

Equality will avoid JSON serialization. Scalar fields use `Object.is`; `gitStats` uses a targeted property comparison; `sessionSummaries` uses stable deep equality because it is an array of structured runtime summaries. Derived structured fields (`sidebarStatus` and `statusReason`) use targeted property comparisons, while derived scalar fields use `Object.is`.

The raw session `isWorking` signal remains tracked in `rawSessionIsWorkingByWorkspaceId`, because the public entry's `isWorking` field is derived. Equality for an incoming session activity value compares against that raw signal, not against the public derived field.

Every accepted update computes a derived-state candidate because flow derivation contains time-sensitive behavior, including the unknown-CI grace window. The candidate is compared to the stored derived fields before assignment. If neither raw values nor the derived candidate changed, `upsert()` returns after advancing timestamps without changing public metadata, incrementing the public version, updating indexes, or emitting. A raw or derived change emits one consistent entry.

New entries always count as changed and emit their initial seed. Stale updates and updates blocked by removal tombstones return an ignored result. A newer upsert after removal recreates the entry normally and clears the tombstone.

## Reconciliation Metrics

`SnapshotReconciliationService.reconcile()` will aggregate store outcomes and report:

- `workspacesScanned`: authoritative workspaces processed;
- `workspacesChanged`: upserts whose public/raw state changed;
- `deltasEmitted`: `SNAPSHOT_CHANGED` events emitted by those upserts plus successful stale-entry removal deltas.

The existing reconciliation diagnostics remain available for compatibility. The completion log includes all three new metrics so idle passes are observable as scanned workspaces with zero changes and zero deltas.

## Testing

Store tests will prove:

- newer equal scalar values advance timestamps without version or event changes;
- equal `gitStats` and `sessionSummaries` are stable no-ops;
- genuine scalar and structured changes emit exactly once;
- a stale update cannot overwrite a value confirmed by a newer equal reconciliation;
- removal tombstones still block stale recreation and allow genuinely newer recreation;
- an accepted update whose raw values are equal but whose time-sensitive derived state changed emits the correct derived snapshot.

Reconciliation tests will use upsert outcomes to prove repeated unchanged fixtures produce zero changed workspaces and zero deltas after the seed, and will verify the new summary log fields.

## Non-Goals

Client-side animation-frame batching is not included because eliminating the guaranteed backend no-op events removes the identified fan-out at its source. No UI behavior or wire format changes are required.
